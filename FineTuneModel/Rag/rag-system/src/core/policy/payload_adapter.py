"""
Payload adapter — the single point of contact with the data-transport layer's
Qdrant payload schema.

The external schema is NOT finalised. Rather than scatter their field names
across the retrieval, rule-evaluation and judging code, every mapping lives here
behind an alias table. When they confirm (or change) a field name, edit `_ALIASES`
and nothing else moves.

This mirrors the `IRetriever` idea already in this codebase: isolate the volatile
external detail behind one stable internal shape.

It also fails *loudly and specifically*: if `applies_to_actions` never arrives,
deterministic rule retrieval is impossible, and that is a risk someone must accept
explicitly rather than discover after a wrong payroll decision.
"""
import logging
from typing import Any

from src.core.actions.action_registry import action_names
from src.types.policy import DocType, PolicyMeta, RiskLevel, ThresholdUnit

logger = logging.getLogger(__name__)

# Internal field  →  candidate external names, tried in order.
# Extend the lists as the other team's schema firms up; do not rename the keys.
_ALIASES: dict[str, tuple[str, ...]] = {
    "policy_id":       ("policy_id", "policyId", "rule_id", "id", "doc_id"),
    "doc_type":        ("doc_type", "docType", "type", "category", "document_type"),
    "title":           ("title", "name", "rule_title", "heading"),
    "applies_to_actions": (
        "applies_to_actions", "appliesToActions", "actions",
        "applies_to", "action_types", "applicable_actions",
    ),
    "risk_level":      ("risk_level", "riskLevel", "severity", "risk"),
    "mandatory": (
        "mandatory", "isMandatory", "is_mandatory",
        "always_apply", "alwaysApply", "global",
    ),
    "version":         ("version", "policy_version", "policyVersion", "rev", "revision"),
    "effective_date":  ("effective_date", "effectiveDate", "valid_from", "validFrom", "start_date"),
    "expires_date":    ("expires_date", "expiresDate", "valid_to", "validTo", "end_date"),
    "is_current":      ("is_current", "isCurrent", "active", "current"),
    "section":         ("section", "clause", "section_ref", "sectionRef", "clause_no", "clauseNo"),
    "source_document": ("source_document", "sourceDocument", "source", "filename"),
    "threshold_value": ("threshold_value", "thresholdValue", "threshold", "limit"),
    "threshold_unit":  ("threshold_unit", "thresholdUnit", "unit"),
    "requires_role":   ("requires_role", "requiresRole", "approver_roles", "roles"),
    "enforces":        ("enforces", "enforcesChecks", "enforces_checks", "controls"),
}

_KNOWN_ACTIONS = set(action_names())

# Track unmapped-field warnings so a malformed corpus reports once, not per chunk.
_warned: set[str] = set()


def _warn_once(key: str, message: str) -> None:
    if key not in _warned:
        _warned.add(key)
        logger.warning(message)


def _pick(payload: dict[str, Any], field: str) -> Any:
    """First present alias for `field`, else None."""
    for alias in _ALIASES[field]:
        if alias in payload and payload[alias] is not None:
            return payload[alias]
    return None


def _as_list(value: Any) -> list[str]:
    """Coerce scalar / comma-string / list into a list of trimmed strings."""
    if value is None:
        return []
    if isinstance(value, str):
        return [p.strip() for p in value.split(",") if p.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [str(value).strip()]


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in ("true", "yes", "1", "y")


def _as_enum(value: Any, enum_cls, default):
    if value is None:
        return default
    try:
        return enum_cls(str(value).strip().lower())
    except ValueError:
        _warn_once(
            f"enum:{enum_cls.__name__}:{value}",
            f"unrecognised {enum_cls.__name__} value {value!r}; falling back to {default}",
        )
        return default


def flatten(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Merge a nested `metadata` sub-dict up to the top level.

    LangChain's Qdrant integration nests metadata under a `metadata` key, but a
    hand-rolled ingestion pipeline usually writes flat payloads. Accept both.
    """
    flat = {k: v for k, v in payload.items() if k != "metadata"}
    nested = payload.get("metadata")
    if isinstance(nested, dict):
        for k, v in nested.items():
            flat.setdefault(k, v)
    return flat


def to_policy_meta(payload: dict[str, Any]) -> PolicyMeta:
    """
    Normalise one raw Qdrant payload into `PolicyMeta`.

    Never raises — a chunk with unusable metadata still needs to be represented so
    it can be counted and reported, rather than vanishing silently from a decision.
    Missing `policy_id` becomes a synthetic "unknown:*" id so it is visibly wrong
    in the audit trail instead of invisibly absent.
    """
    flat = flatten(payload)

    policy_id = _pick(flat, "policy_id")
    if not policy_id:
        source = _pick(flat, "source_document") or "unidentified"
        policy_id = f"unknown:{source}"
        _warn_once(
            "missing_policy_id",
            "policy chunk(s) have no policy_id under any known alias — decisions "
            "citing them cannot be traced to a source rule",
        )

    raw_actions = _as_list(_pick(flat, "applies_to_actions"))
    unknown = [a for a in raw_actions if a not in _KNOWN_ACTIONS]
    if unknown:
        _warn_once(
            f"unknown_actions:{','.join(sorted(unknown))}",
            f"policy tagged with unregistered action(s) {unknown} — these will never "
            f"match a request; check spelling against action_registry.action_names()",
        )

    return PolicyMeta(
        policy_id=str(policy_id),
        doc_type=_as_enum(_pick(flat, "doc_type"), DocType, DocType.UNKNOWN),
        title=str(_pick(flat, "title") or ""),
        applies_to_actions=raw_actions,
        risk_level=_as_enum(_pick(flat, "risk_level"), RiskLevel, RiskLevel.MEDIUM),
        mandatory=_as_bool(_pick(flat, "mandatory"), False),
        version=str(_pick(flat, "version") or "unversioned"),
        effective_date=_opt_str(_pick(flat, "effective_date")),
        expires_date=_opt_str(_pick(flat, "expires_date")),
        is_current=_as_bool(_pick(flat, "is_current"), True),
        section=_opt_str(_pick(flat, "section")),
        source_document=_opt_str(_pick(flat, "source_document")),
        threshold_value=_opt_float(_pick(flat, "threshold_value")),
        threshold_unit=(
            _as_enum(_pick(flat, "threshold_unit"), ThresholdUnit, None)
            if _pick(flat, "threshold_unit") is not None
            else None
        ),
        requires_role=_as_list(_pick(flat, "requires_role")),
        enforces=_as_list(_pick(flat, "enforces")),
    )


def _opt_str(value: Any) -> str | None:
    return str(value) if value is not None else None


def _opt_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def audit_payload_schema(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Report how well a sample of real payloads satisfies the contract.

    Run this against the live collection as soon as the data-transport layer has
    ingested anything — it turns "we hope the schema is right" into a number, and
    tells you which contract fields are missing before they cause a bad decision.
    """
    total = len(payloads)
    coverage: dict[str, int] = {f: 0 for f in _ALIASES}
    resolved_alias: dict[str, set[str]] = {f: set() for f in _ALIASES}

    for raw in payloads:
        flat = flatten(raw)
        for field, aliases in _ALIASES.items():
            for alias in aliases:
                if alias in flat and flat[alias] is not None:
                    coverage[field] += 1
                    resolved_alias[field].add(alias)
                    break

    critical = ("doc_type", "policy_id", "applies_to_actions", "mandatory", "version")
    missing_critical = [f for f in critical if coverage[f] < total]

    return {
        "sampled": total,
        "coverage": {f: f"{n}/{total}" for f, n in coverage.items()},
        "aliases_seen": {f: sorted(a) for f, a in resolved_alias.items() if a},
        "missing_critical": missing_critical,
        "contract_satisfied": not missing_critical,
    }
