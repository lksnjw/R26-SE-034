from fastapi import APIRouter

from src.core.registration.gate import evaluate
from src.types.registration import RegistrationRequest, RegistrationResponse

router = APIRouter(prefix="/api/policy", tags=["Employee registration"])


@router.post("/evaluate", response_model=RegistrationResponse)
@router.post("/employee-registration/validate", response_model=RegistrationResponse)
async def validate_registration(request: RegistrationRequest) -> RegistrationResponse:
    """Trusted ERP backend only. Call before create-user; proceed only on ALLOW."""
    return await evaluate(request)


@router.get("/actions")
def actions():
    return {"actions": [{"name": "create_employee_user", "flow": "employee_registration", "required_verdict": "ALLOW"}]}
