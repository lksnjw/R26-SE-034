"""Read-only registration validation; the ERP must enforce the gate in code."""
from mcp.server import MCPServer

from src.core.registration.gate import evaluate
from src.types.registration import RegistrationRequest

mcp = MCPServer("policy-gate", instructions="Validate Sri Lankan employee registration. Never create users. Only ALLOW permits the ERP backend to continue.")


@mcp.tool()
async def check_policy(request: RegistrationRequest) -> dict:
    """Validate a form. Requester and duplicate evidence must come from the trusted ERP backend, never an LLM or form. BLOCK/ESCALATE must stop creation."""
    return (await evaluate(request)).model_dump(mode="json")
