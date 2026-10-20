# EMP-REG-005 — Sri Lanka Location Validation Policy

## Rules
1. Location is mandatory.
2. The employee location must be within Sri Lanka.
3. Accepted country identifiers are `Sri Lanka`, `LK`, and `LKA`.
4. Any location explicitly identifying another country is blocked.
5. If province or district is provided, it must be a valid Sri Lankan province or district.
6. Ambiguous locations that cannot be verified as Sri Lankan are escalated.
7. Country must not be inferred from the phone number alone.
8. The system must never silently replace a foreign country with Sri Lanka.
