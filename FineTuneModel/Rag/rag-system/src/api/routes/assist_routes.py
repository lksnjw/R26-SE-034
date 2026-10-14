"""
Assist routes — the read-only tool planner the calling application talks to.

Separate router from policy_routes.py on purpose: this endpoint can only ever
plan `read`-kind tool calls or answer from results already shown to it (see
src/core/assist/assist_gate.py). Anything that mutates ERP state goes to
POST /api/policy/evaluate instead — see docs/ASSIST_CONTRACT.md §7.
"""
# pyrefly: ignore [missing-import]
from fastapi import APIRouter

from src.api.controller.assist_controller import handle_assist
from src.types.assist import AssistRequest, AssistResponse

router = APIRouter(prefix="/api", tags=["Assist"])


@router.post(
    "/assist",
    response_model=AssistResponse,
    summary="Plan read-only tool calls, or answer from ones already run",
    description=(
        "Send a natural-language request, who is asking, the read-only tools "
        "you're willing to run, and the history of any tool calls/results from "
        "prior turns. Returns either a plan of tool calls to run next "
        "(`needs_tools`), a grounded final answer (`final`), or a refusal "
        "(`refused`).\n\n"
        "This endpoint never executes anything and holds no state — resend the "
        "full history each turn. Requests to change ERP state are refused here "
        "with a pointer to `POST /api/policy/evaluate`, which is the only "
        "endpoint that decides those."
    ),
)
async def assist_endpoint(request: AssistRequest) -> AssistResponse:
    return await handle_assist(request)
