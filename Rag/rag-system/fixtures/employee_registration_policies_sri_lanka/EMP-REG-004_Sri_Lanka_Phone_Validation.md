# EMP-REG-004 — Sri Lanka Phone Validation Policy

## Rules
1. Phone is mandatory.
2. Only Sri Lankan numbers are accepted.
3. The international country code must be `+94`.
4. A local number beginning with `0` may be normalized to `+94`.
5. After normalization the value must be `+94` followed by 9 digits.
6. Spaces, hyphens, and brackets may be removed during normalization.
7. Alphabetic characters are not allowed.
8. Non-Sri Lankan country codes are blocked.
9. The normalized phone number must be unique among active employee users.

## Examples
- `0771234567` -> `+94771234567` -> ALLOW
- `+94771234567` -> ALLOW
- `+919876543210` -> BLOCK
