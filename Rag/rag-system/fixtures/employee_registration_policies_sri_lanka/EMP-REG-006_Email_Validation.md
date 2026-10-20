# EMP-REG-006 — Employee Email Validation Policy

## Rules
1. Email is mandatory.
2. It must use valid `local-part@domain` structure.
3. Spaces are not permitted.
4. The domain must contain at least one dot.
5. Normalize to lowercase for duplicate checking.
6. Email must be unique among active employee users.
7. Malformed addresses are blocked.
8. If the company maintains an approved corporate-domain list, the entered domain must match that configured list.
9. The model must not invent the company's email domain.
