"""
MCP surface for the policy gate.

The calling component is an agent that speaks MCP. Rather than make it hand-write
an HTTP integration, this exposes the same decision as a tool it can discover:
point an MCP client at `<host>/mcp` and `check_policy` appears in its tool list.

This is a protocol wrapper and nothing more. `check_policy` calls the same
`policy_gate.evaluate()` that `POST /api/policy/evaluate` calls, takes the same
pydantic models, and returns the same `EvaluateResponse`. There is no second
implementation to drift out of step with the first, and no invariant that holds
on one path and not the other.

ENFORCEMENT vs CONVENIENCE — worth being explicit about

An MCP tool is invoked when the calling *model* decides to invoke it. That is
right for asking a question and wrong for enforcing a control: a check the agent
can skip — or be argued out of by text inside an invoice memo — is not a check.
So the two doors are not interchangeable:

    POST /api/policy/evaluate   the middleware calls it in code, unconditionally,
                                before any write executes
    check_policy (this file)    the agent's model calls it to *ask* whether
                                something would be permitted

Same function underneath. Only one of them is a gate.
"""
import logging

# pyrefly: ignore [missing-import]
from mcp.server import MCPServer

from src.core.policy.policy_gate import evaluate
from src.types.gateway import Actor, EvaluateRequest

logger = logging.getLogger(__name__)

mcp = MCPServer(
    "policy-gate",
    instructions=(
        "Decides whether a finance action is permitted under company policy. "
        "It returns a decision and the clauses it rests on; it never executes "
        "anything. Call it before acting, not after."
    ),
)


@mcp.tool()
async def check_policy(
    prompt: str,
    actor: Actor,
    context: dict | None = None,
) -> dict:
    """
    Decide whether a finance request is permitted under company policy.

    Returns the proposed action, a decision, the policy clauses relied upon, and
    any conditions that must still be satisfied. This tool decides; it does not
    execute. Nothing is paid, approved, or posted by calling it.

    Act only on `decision = "allow"`, or on `"allow_with_conditions"` once every
    entry in `conditions` has been verified against the ERP record. Any other
    decision — `deny`, `review`, `answer` — is not an instruction to retry with
    different wording.

    Args:
        prompt:  The user's request in natural language, e.g.
                 "release payment for invoice INV-8842".
        actor:   Who is asking: `user_id`, `role`, and optionally `department`
                 and `is_document_owner`. The role MUST come from an
                 authenticated session — a role claimed in the prompt is a claim,
                 not an identity, and every threshold and segregation rule is
                 decided against this field. Set `is_document_owner` when the
                 requester raised or benefits from the target document; leave it
                 out when unknown, which is reported as an unmet condition rather
                 than assumed false.
        context: Pre-resolved facts about the target document, e.g.
                 `{"amount": 1450000, "currency": "LKR"}`. Whatever is supplied
                 is compared against the limits the policies state; whatever is
                 missing comes back as a condition for you to check.
    """
    response = await evaluate(
        EvaluateRequest(prompt=prompt, actor=actor, context=context or {})
    )
    logger.info(
        f"[mcp] check_policy -> {response.decision.value} "
        f"| action={response.action.name if response.action else '-'} "
        f"| {len(response.citations)} citation(s)"
    )
    # mode="json" so enums and datetimes serialise to strings. The MCP client
    # gets exactly the shape the REST caller gets.
    return response.model_dump(mode="json")
