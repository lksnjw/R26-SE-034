# EMP-REG-002 — Employee Name Validation Policy

## Rules
1. First Name and Last Name are mandatory.
2. Middle Name is optional.
3. Names must not contain digits.
4. Unicode alphabetic characters are permitted, including Sinhala, Tamil, and Latin scripts.
5. Spaces, hyphens, apostrophes, and periods used for initials are allowed.
6. Leading/trailing spaces must be removed.
7. Repeated internal spaces should be normalized.
8. Each name field must be 100 characters or fewer.
9. Placeholder values such as `test`, `unknown`, or `n/a` are not accepted for mandatory name fields.
