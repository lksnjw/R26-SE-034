"""
PolicyController — HTTP layer for the policy gate.

Note the absence of a try/except that turns failures into 500s. The gate already
converts every internal failure into an explicit DENY with a reason, and that is
deliberate: a 500 invites the caller to retry, and a retry loop around a policy
decision is how an action eventually slips through. The caller should receive a
decision, not an error, whenever a decision is possible.
"""
import logging

from src.core.policy.policy_gate import evaluate
from src.types.gateway import EvaluateRequest, EvaluateResponse

logger = logging.getLogger(__name__)


async def handle_evaluate(request: EvaluateRequest) -> EvaluateResponse:
    response = await evaluate(request)
    logger.info(
        f"[{response.request_id}] → {response.decision.value} "
        f"| action={response.action.name if response.action else '-'} "
        f"| {len(response.conditions)} condition(s), {len(response.citations)} citation(s)"
    )
    return response
