"""Metadata selects authority; semantic results can supplement, never remove it."""
from qdrant_client.http import models as qm

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.embeddings.embedding_service import get_embeddings
from src.core.registration.corpus import FLOW, FIELDS, GLOBAL_IDS, load_corpus


def policy_filter(field: str | None = None, include_global: bool = True) -> qm.Filter:
    must = [
        qm.FieldCondition(key="metadata.flow", match=qm.MatchValue(value=FLOW)),
        qm.FieldCondition(key="metadata.active", match=qm.MatchValue(value=True)),
        qm.FieldCondition(key="metadata.country", match=qm.MatchValue(value="Sri Lanka")),
    ]
    if field:
        choices = [qm.FieldCondition(key="metadata.field", match=qm.MatchValue(value=field))]
        if include_global:
            choices.append(qm.FieldCondition(key="metadata.policy_id", match=qm.MatchAny(any=sorted(GLOBAL_IDS))))
        must.append(qm.Filter(should=choices))
    return qm.Filter(must=must)


class RegistrationRetriever:
    def __init__(self, client=None, embeddings=None):
        self.client = client if client is not None else get_qdrant_client()
        self.embeddings = embeddings

    def retrieve(self, field: str | None = None, query: str = "Sri Lankan employee registration validation") -> list[dict]:
        if field and field not in {f for values in FIELDS.values() for f in values}:
            raise ValueError(f"Unknown registration field: {field}")
        selected = policy_filter(field)
        points, offset = self.client.scroll(settings.POLICY_COLLECTION, scroll_filter=selected, limit=256, with_payload=True)
        while offset is not None:
            page, offset = self.client.scroll(settings.POLICY_COLLECTION, scroll_filter=selected, offset=offset, limit=256, with_payload=True)
            points.extend(page)
        # Embed field names / intent, not employee PII. The metadata predicates
        # already return every required section regardless of semantic rank.
        embedder = self.embeddings if self.embeddings is not None else get_embeddings()
        vector = embedder.embed_query(query)
        semantic = self.client.query_points(settings.POLICY_COLLECTION, query=vector, query_filter=selected, limit=settings.POLICY_TOP_K).points
        by_id = {str(p.id): p.payload for p in [*points, *semantic]}
        expected = {c["id"]: c for c in load_corpus() if not field or field in c["metadata"]["field"] or c["metadata"]["policy_id"] in GLOBAL_IDS}
        # Fail closed on missing sections, stale text, changed files, or a mixed
        # embedding model. Never execute coded rules against unrelated authority.
        model = settings.API_EMBED_MODEL if settings.MODEL_PROVIDER in ("api", "openrouter") else settings.EMBED_MODEL
        for pid, chunk in expected.items():
            payload = by_id.get(pid) or {}
            if payload.get("text") != chunk["text"] or any(payload.get("metadata", {}).get(k) != v for k, v in chunk["metadata"].items()):
                raise RuntimeError("Registration corpus is incomplete or stale; re-seed the authoritative files")
            if payload["metadata"].get("embedding_model") != model:
                raise RuntimeError("Registration embedding model changed; re-seed")
        return [by_id[pid] for pid in expected]
