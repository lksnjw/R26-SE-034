# EMP-REG-008 — Duplicate Employee User Detection Policy

## Rules
1. Duplicate checking occurs before final creation.
2. Email must be unique.
3. Normalized phone must be unique.
4. Same normalized name plus the same Birth Date is a potential duplicate and must be escalated.
5. Same name plus matching phone or email must be blocked unless this is an approved correction of an existing record.
6. Capitalization and spacing differences must not bypass duplicate checks.

## Decisions
- Exact active email match -> BLOCK
- Exact normalized phone match -> BLOCK
- Same name + same Birth Date -> ESCALATE
