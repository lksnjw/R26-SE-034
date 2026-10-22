# EMP-REG-001 — Employee User Registration Governance Policy

**Scope:** ERP employee registration for Sri Lanka only  
**Status:** Synthetic research policy for RAG validation

## Rules
1. Only an authorized HR Administrator or System Administrator may create a new employee user.
2. Managers may request registration but may not create the user unless they also hold an approved administrator role.
3. Self-registration is not permitted.
4. The creator must be authenticated and recorded in the audit trail.
5. All mandatory fields must pass validation before creation.
6. Foreign-country employee registrations are outside this workflow.
7. The employee record is created only when the final validation result is ALLOW.

## Mandatory fields
Gender, Birth Date, Phone, Location, Email, First Name, Last Name, Language, Time Zone.

## Optional field
Middle Name.
