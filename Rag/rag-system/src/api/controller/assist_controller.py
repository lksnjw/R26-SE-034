"""
AssistController — HTTP layer for the read-tool planner.

Same shape as policy_controller.py: no try/except here either. The gate
already converts every internal failure into an explicit `refused` with a
reason, for the same reason policy_controller.py gives — a 500 invites a
retry, and a retry loop around a decision this system already made safely is
how a control gets worn down.
"""
import logging

from src.core.assist.assist_gate import assist
from src.types.assist import AssistRequest, AssistResponse

logger = logging.getLogger(__name__)


async def handle_assist(request: AssistRequest) -> AssistResponse:
    response = await assist(request)
    logger.info(
        f"[{response.request_id}] -> {response.status.value} "
        f"| {len(response.tool_calls)} tool call(s), {len(response.used)} used"
    )
    return response
