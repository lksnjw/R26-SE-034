from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StrictBool


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Employee(StrictModel):
    gender: str | None = Field(None, validation_alias=AliasChoices("gender", "Gender"))
    birth_date: str | None = Field(None, validation_alias=AliasChoices("birth_date", "Birth Date"))
    phone: str | None = Field(None, validation_alias=AliasChoices("phone", "Phone"))
    location: str | None = Field(None, validation_alias=AliasChoices("location", "Location"))
    email: str | None = Field(None, validation_alias=AliasChoices("email", "Email"))
    first_name: str | None = Field(None, validation_alias=AliasChoices("first_name", "First Name"))
    middle_name: str | None = Field(None, validation_alias=AliasChoices("middle_name", "Middle Name"))
    last_name: str | None = Field(None, validation_alias=AliasChoices("last_name", "Last Name"))
    language: str | None = Field(None, validation_alias=AliasChoices("language", "Language"))
    time_zone: str | None = Field(None, validation_alias=AliasChoices("time_zone", "Time Zone"))


class Requester(StrictModel):
    """Assertions supplied only by the authenticated ERP backend, never the form."""
    user_id: str = ""
    roles: list[str] = Field(default_factory=list)
    authenticated: StrictBool = False
    self_registration: StrictBool | None = None


class DuplicateCheck(StrictModel):
    """Backend attestations bound to the normalized values actually checked."""
    reference: str
    email: str
    phone: str
    normalized_name: str
    birth_date: str
    active_email_match: StrictBool
    active_phone_match: StrictBool
    name_birth_date_match: StrictBool


class RegistrationRequest(StrictModel):
    employee: Employee
    requester: Requester = Field(default_factory=Requester)
    duplicate_check: DuplicateCheck | None = None
    employee_reference: str = ""


class Finding(StrictModel):
    verdict: Literal["BLOCK", "ESCALATE"]
    policy_id: str
    field: str
    reason: str


class RegistrationResponse(StrictModel):
    verdict: Literal["ALLOW", "BLOCK", "ESCALATE"]
    justification: str
    failed_policies: list[str]
    failed_fields: list[str]
    normalized_employee: Employee
    findings: list[Finding]
    retrieved_policies: list[str]
    audit: dict
    can_create: bool
