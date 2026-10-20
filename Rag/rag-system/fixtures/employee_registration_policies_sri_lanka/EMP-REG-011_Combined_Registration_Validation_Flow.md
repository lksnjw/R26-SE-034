# EMP-REG-011 — Combined Employee Registration Validation Flow

## Validation order
1. Requester authorization -> EMP-REG-001
2. Mandatory field completeness -> EMP-REG-009
3. Names -> EMP-REG-002
4. Gender and Birth Date -> EMP-REG-003
5. Phone -> EMP-REG-004
6. Location -> EMP-REG-005
7. Email -> EMP-REG-006
8. Language and Time Zone -> EMP-REG-007
9. Duplicate detection -> EMP-REG-008
10. Final decision and audit -> EMP-REG-010

The ERP must not create the employee until the result is ALLOW.
