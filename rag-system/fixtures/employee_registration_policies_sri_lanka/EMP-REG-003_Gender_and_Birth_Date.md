# EMP-REG-003 — Gender and Birth Date Validation Policy

## Gender
Accepted values:
- Female
- Male
- Other
- Prefer not to say

Values outside the accepted list are blocked.

## Birth Date
1. Birth Date is mandatory.
2. It must be a valid calendar date.
3. Store as `YYYY-MM-DD`.
4. It must not be in the future.
5. It must not be today's date.
6. Missing or invalid dates are blocked.
7. Clearly implausible dates are escalated for HR review.
