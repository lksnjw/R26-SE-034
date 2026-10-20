# EMP-REG-010 — Validation Decision and Audit Policy

## ALLOW
Use ALLOW only when:
- creator is authorized;
- all mandatory fields are present;
- every field passes its validation policy;
- no duplicate conflict exists;
- location is Sri Lanka;
- phone is Sri Lankan;
- time zone is accepted.

## BLOCK
Use BLOCK when:
- creator is unauthorized;
- a mandatory field is missing;
- a field is malformed;
- country is not Sri Lanka;
- phone country code is not `+94`;
- time zone is not accepted;
- language is unsupported;
- an exact duplicate email or phone exists.

## ESCALATE
Use ESCALATE when:
- location is ambiguous;
- a potential duplicate needs human confirmation;
- a plausible value cannot be verified automatically.

## Audit
Record requester ID, timestamp, submitted employee reference, validation result, failed policy IDs, and any manual override.
