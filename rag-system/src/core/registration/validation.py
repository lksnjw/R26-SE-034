"""Deterministic checks implementing EMP-REG-001 through EMP-REG-009.

Narrative uncertainty (geography and birth-date plausibility) is left for the
grounded judge. There is deliberately no invented minimum/maximum employee age.
"""
import re
import unicodedata
from datetime import date

from src.config.settings import settings
from src.types.registration import Employee, Finding, RegistrationRequest

REQUIRED = ["gender", "birth_date", "phone", "location", "email", "first_name", "last_name", "language", "time_zone"]


def spaces(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def normalized_name(employee: Employee) -> str:
    return spaces(" ".join(getattr(employee, key) or "" for key in ("first_name", "middle_name", "last_name"))).casefold()


def normalize_phone(value: str) -> str:
    value = re.sub(r"[\s()\-]", "", value)
    return "+94" + value[1:] if re.fullmatch(r"0[0-9]{9}", value) else value


def validate(request: RegistrationRequest, today: date) -> tuple[Employee, list[Finding]]:
    data = {k: spaces(v) if v is not None else None for k, v in request.employee.model_dump().items()}
    employee = Employee(**data)
    findings = []

    def add(pid, field, reason, verdict="BLOCK"):
        findings.append(Finding(verdict=verdict, policy_id=pid, field=field, reason=reason))

    actor = request.requester
    roles = {spaces(role).casefold() for role in actor.roles}
    if not actor.authenticated or not actor.user_id.strip() or not roles.intersection({"hr administrator", "system administrator"}):
        add("EMP-REG-001", "requester", "An authenticated HR Administrator or System Administrator is required.")
    if actor.self_registration is True:
        add("EMP-REG-001", "requester", "Self-registration is not permitted.")
    elif actor.self_registration is None:
        add("EMP-REG-001", "requester", "The backend must verify that this is not self-registration.", "ESCALATE")

    for field in REQUIRED:
        if not getattr(employee, field):
            add("EMP-REG-009", field, f"{field} is mandatory.")

    for field in ("first_name", "middle_name", "last_name"):
        name = getattr(employee, field)
        if not name:
            continue
        valid = any(unicodedata.category(c).startswith("L") for c in name) and all(
            unicodedata.category(c)[0] in "LM" or c in " -'’." or c in "\u200c\u200d" for c in name
        )
        if not valid or len(name) > 100 or (field != "middle_name" and name.casefold() in {"test", "unknown", "n/a"}):
            add("EMP-REG-002", field, "Names require Unicode letters, permitted separators, no digits, at most 100 characters, and no mandatory-field placeholders.")

    if employee.gender:
        genders = {v.casefold(): v for v in ("Female", "Male", "Other", "Prefer not to say")}
        if employee.gender.casefold() in genders:
            employee.gender = genders[employee.gender.casefold()]
        else:
            add("EMP-REG-003", "gender", "Gender must be Female, Male, Other, or Prefer not to say.")
    if employee.birth_date:
        try:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", employee.birth_date):
                raise ValueError()
            born = date.fromisoformat(employee.birth_date)
            if born >= today:
                raise ValueError()
        except ValueError:
            add("EMP-REG-003", "birth_date", "Birth date must be a valid YYYY-MM-DD calendar date before today.")

    if employee.phone:
        employee.phone = normalize_phone(employee.phone)
        if not re.fullmatch(r"\+94[0-9]{9}", employee.phone):
            add("EMP-REG-004", "phone", "Phone must normalize to Sri Lanka country code +94 followed by exactly 9 digits; foreign country codes are blocked.")

    if employee.email:
        employee.email = employee.email.lower()
        parts = employee.email.split("@")
        valid = len(parts) == 2 and not any(c.isspace() for c in employee.email)
        if valid:
            local, domain = parts
            labels = domain.split(".")
            valid = bool(re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)) and not local.startswith(".") and not local.endswith(".") and ".." not in local
            valid = valid and len(labels) >= 2 and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) for label in labels)
        if not valid:
            add("EMP-REG-006", "email", "Email must have a valid local-part@domain structure without spaces and a dotted domain.")
        elif settings.REGISTRATION_EMAIL_DOMAINS:
            domains = {d.strip().lower() for d in settings.REGISTRATION_EMAIL_DOMAINS.split(",") if d.strip()}
            if domains and parts[1] not in domains:
                add("EMP-REG-006", "email", "Email domain is outside the configured corporate-domain list.")

    if employee.language:
        languages = {"english": "English", "sinhala": "Sinhala", "tamil": "Tamil", "en": "English", "si": "Sinhala", "ta": "Tamil"}
        if employee.language.casefold() in languages:
            employee.language = languages[employee.language.casefold()]
        else:
            add("EMP-REG-007", "language", "Supported languages are English, Sinhala, and Tamil (en, si, ta).")
    if employee.time_zone:
        if employee.time_zone == "UTC+05:30" and settings.REGISTRATION_MAP_UTC_OFFSET:
            employee.time_zone = "Asia/Colombo"
        if employee.time_zone != "Asia/Colombo":
            add("EMP-REG-007", "time_zone", "Time zone must be Asia/Colombo; foreign zones are not accepted.")

    # Evidence must describe the same normalized values. Missing checks are
    # unknown, never equivalent to a negative match against the ERP.
    check = request.duplicate_check
    if check is None or not check.reference.strip():
        add("EMP-REG-008", "duplicates", "Active-user duplicate checks have not been supplied by the ERP backend.", "ESCALATE")
    elif (check.email, check.phone, check.normalized_name, check.birth_date) != (
        employee.email, employee.phone, normalized_name(employee), employee.birth_date
    ):
        add("EMP-REG-008", "duplicates", "Duplicate-check evidence does not match the normalized submission; repeat the lookup.", "ESCALATE")
    else:
        if check.active_email_match:
            add("EMP-REG-008", "email", "Email already belongs to an active employee user.")
        if check.active_phone_match:
            add("EMP-REG-008", "phone", "Normalized phone already belongs to an active employee user.")
        if check.name_birth_date_match:
            add("EMP-REG-008", "duplicates", "The same normalized name and birth date exist; human verification is required.", "ESCALATE")
    return employee, findings
