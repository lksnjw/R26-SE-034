"""
Policy routes — the gate the calling application talks to.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter

from src.api.controller.policy_controller import handle_evaluate
from src.core.actions.action_registry import REGISTRY_VERSION, all_actions
from src.types.gateway import EvaluateRequest, EvaluateResponse

router = APIRouter(prefix="/api/policy", tags=["Policy gate"])


@router.post(
    "/evaluate",
    response_model=EvaluateResponse,
    summary="Decide whether a finance request is permitted",
    description=(
        "Send a natural-language finance request and who is asking. Returns the "
        "action to perform, whether policy permits it, the clauses relied upon, and "
        "any conditions still to be satisfied.\n\n"
        "**Execute only** on `decision=allow`, or on `decision=allow_with_conditions` "
        "once every entry in `conditions` has been checked against the ERP record. "
        "This service never executes anything itself."
    ),
)
async def evaluate(request: EvaluateRequest) -> EvaluateResponse:
    return await handle_evaluate(request)


@router.get(
    "/actions",
    summary="List the action vocabulary",
    description=(
        "The exact action names this gate recognises. The policy corpus is tagged "
        "against these strings, and the calling application should build its "
        "execution mapping from this list rather than hard-coding names."
    ),
)
def actions() -> dict:
    return {
        "registry_version": REGISTRY_VERSION,
        "actions": [
            {
                "name": spec.name.value,
                "description": spec.description,
                "risk": spec.risk.value,
                "parameters": spec.params_schema,
            }
            for spec in all_actions()
        ],
    }
