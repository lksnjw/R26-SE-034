"""
PolicyRetriever — fetches the rules that govern an action.

THE POINT OF THIS FILE

Semantic top-k alone cannot guarantee a rule was seen. An employee types
"bump this payment through" and the rule "payments exceeding 1,000,000 require
dual authorization" ranks #14; with top_k=10 the decision engine never sees it
and the payment goes out.

So retrieval here is a UNION OF THREE QUERIES, not a search:

  (a) mandatory rules      — filter only, similarity never consulted
  (b) action-tagged rules  — filter only, every rule tagged for this action
  (c) semantic top-k       — supplement, can add context but never subtracts

(a) and (b) are database predicates over indexed payload fields. They cannot be
defeated by phrasing, which is the entire reason `applies_to_actions` and
`mandatory` exist in the payload contract.

FAIL LOUD, NOT OPEN
Every error path raises. A policy gate that answers while its rule store is
unreachable is worse than one that refuses: the caller would receive an
allow-shaped response derived from no rules at all.
"""
import logging

from qdrant_client.http import models as qm

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.embeddings.embedding_service import get_embeddings
from src.core.policy.payload_adapter import to_policy_meta
from src.types.policy import DocType, PolicyMeta

logger = logging.getLogger(__name__)

# Only these may be used as authority. company_data is excluded structurally so a
# vendor note can never be handed to the judge as if it were a rule.
_GOVERNING = [DocType.POLICY.value, DocType.RULE.value, DocType.PRIVACY_POLICY.value]

CONTENT_KEY = "page_content"


class PolicyChunk:
    """One retrieved clause plus where it came from."""

    __slots__ = ("text", "meta", "score", "via")

    def __init__(self, text: str, meta: PolicyMeta, score: float | None, via: str) -> None:
        self.text = text
        self.meta = meta
        self.score = score
        self.via = via          # "mandatory" | "action" | "semantic"

    @property
    def key(self) -> str:
        return f"{self.meta.citation}|{self.text[:60]}"

    def __repr__(self) -> str:
        return f"<PolicyChunk {self.meta.citation} via={self.via}>"


class RetrievalResult:
    def __init__(self) -> None:
        self.chunks: list[PolicyChunk] = []
        self.counts: dict[str, int] = {"mandatory": 0, "action": 0, "semantic": 0}

    @property
    def total_unique(self) -> int:
        return len(self.chunks)

    @property
    def policy_refs(self) -> list[str]:
        seen: list[str] = []
        for chunk in self.chunks:
            ref = f"{chunk.meta.policy_id}@{chunk.meta.version}"
            if ref not in seen:
                seen.append(ref)
        return seen


# ── Filters ──────────────────────────────────────────────────────────────────


def _base_conditions() -> list[qm.FieldCondition]:
    """
    Applied to every query without exception.

    is_current=False keeps superseded versions in the collection for audit
    ("which version approved this in March?") while making them unreachable for
    a decision about today.
    """
    return [
        qm.FieldCondition(key="metadata.is_current", match=qm.MatchValue(value=True)),
        qm.FieldCondition(key="metadata.doc_type", match=qm.MatchAny(any=_GOVERNING)),
    ]


def _mandatory_filter() -> qm.Filter:
    return qm.Filter(
        must=[
            *_base_conditions(),
            qm.FieldCondition(key="metadata.mandatory", match=qm.MatchValue(value=True)),
        ]
    )


def _action_filter(action: str) -> qm.Filter:
    return qm.Filter(
        must=[
            *_base_conditions(),
            qm.FieldCondition(
                key="metadata.applies_to_actions", match=qm.MatchValue(value=action)
            ),
        ]
    )


def _semantic_filter() -> qm.Filter:
    return qm.Filter(must=list(_base_conditions()))


# ── Retriever ────────────────────────────────────────────────────────────────


class PolicyRetriever:
    def __init__(self) -> None:
        self._client = get_qdrant_client()
        self._embeddings = get_embeddings()
        self._collection = settings.POLICY_COLLECTION

    def _to_chunks(self, points, via: str) -> list[PolicyChunk]:
        chunks = []
        for point in points:
            payload = point.payload or {}
            text = payload.get(CONTENT_KEY) or ""
            if not text:
                continue
            chunks.append(
                PolicyChunk(
                    text=text,
                    meta=to_policy_meta(payload),
                    score=getattr(point, "score", None),
                    via=via,
                )
            )
        return chunks

    def _scroll_all(self, policy_filter: qm.Filter, via: str) -> list[PolicyChunk]:
        """
        Fetch every match, not a page of them.

        A limit here would silently reintroduce the problem this design exists to
        remove — a governing rule dropped because it fell off the end of a page.
        """
        chunks: list[PolicyChunk] = []
        offset = None
        while True:
            points, offset = self._client.scroll(
                collection_name=self._collection,
                scroll_filter=policy_filter,
                limit=256,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            chunks.extend(self._to_chunks(points, via))
            if offset is None:
                break
        return chunks

    def _search(self, prompt: str, limit: int):
        """Similarity search under the standing filters. Returns scored points."""
        vector = self._embeddings.embed_query(prompt)
        return self._client.query_points(
            collection_name=self._collection,
            query=vector,
            query_filter=_semantic_filter(),
            limit=limit,
            with_payload=True,
        ).points

    def retrieve(self, action: str, prompt: str, top_k: int | None = None) -> RetrievalResult:
        """
        Every rule governing `action`, plus semantically related context.

        Raises if Qdrant is unreachable — the caller must fail closed rather than
        decide on an empty rule set.
        """
        k = top_k if top_k is not None else settings.POLICY_TOP_K
        result = RetrievalResult()
        seen: set[str] = set()

        def add(chunks: list[PolicyChunk], bucket: str) -> None:
            for chunk in chunks:
                result.counts[bucket] += 1
                if chunk.key in seen:
                    continue        # already retrieved by a stronger query
                seen.add(chunk.key)
                result.chunks.append(chunk)

        # (a) + (b) — deterministic. Order matters: a rule that is both mandatory
        # and action-tagged should be attributed to the stronger reason.
        add(self._scroll_all(_mandatory_filter(), "mandatory"), "mandatory")
        add(self._scroll_all(_action_filter(action), "action"), "action")

        deterministic = len(result.chunks)
        if result.counts["action"] == 0:
            # Not an empty result — a corpus gap. Deciding this action on
            # mandatory rules alone means no specific rule governs it.
            logger.error(
                f"no policy tagged applies_to_actions='{action}' in "
                f"'{self._collection}' — this action has NO specific policy coverage"
            )

        # (c) — supplement only.
        add(self._to_chunks(self._search(prompt, k), "semantic"), "semantic")

        logger.info(
            f"policy retrieval action='{action}' | mandatory={result.counts['mandatory']} "
            f"action={result.counts['action']} semantic={result.counts['semantic']} "
            f"| {deterministic} deterministic + {len(result.chunks) - deterministic} "
            f"semantic-only = {result.total_unique} unique"
        )
        return result

    def search_semantic(self, prompt: str, top_k: int | None = None) -> list[PolicyChunk]:
        """
        Similarity search with no action filter — for answering policy questions.

        Still confined to `policy_docs` under the same doc_type and is_current
        predicates, so a question can never be answered out of company data or a
        rule that was replaced last year.
        """
        limit = top_k if top_k is not None else settings.POLICY_TOP_K
        return self._to_chunks(self._search(prompt, limit), "semantic")

    def has_coverage(self, action: str) -> bool:
        """True if any current policy is tagged for this action."""
        points, _ = self._client.scroll(
            collection_name=self._collection,
            scroll_filter=_action_filter(action),
            limit=1,
            with_payload=False,
            with_vectors=False,
        )
        return bool(points)

    def governing(self, action: str) -> list[PolicyChunk]:
        """
        Every rule that governs `action` by filter alone — no similarity.

        This is queries (a) and (b) without (c), which is what a coverage audit
        needs: a clause pulled in by similarity is not coverage, it is a
        coincidence of wording that a rephrased request would lose.
        """
        chunks: list[PolicyChunk] = []
        seen: set[str] = set()
        for found in (
            self._scroll_all(_mandatory_filter(), "mandatory"),
            self._scroll_all(_action_filter(action), "action"),
        ):
            for chunk in found:
                if chunk.key not in seen:
                    seen.add(chunk.key)
                    chunks.append(chunk)
        return chunks

    def corpus_size(self) -> int:
        """Number of policy chunks the gate can currently see."""
        return self._client.get_collection(self._collection).points_count or 0


_instance: PolicyRetriever | None = None


def get_policy_retriever() -> PolicyRetriever:
    global _instance
    if _instance is None:
        _instance = PolicyRetriever()
    return _instance
