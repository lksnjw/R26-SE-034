# EMP-REG-009 — Field Completeness and Normalization Policy

## Mandatory fields
Gender, Birth Date, Phone, Location, Email, First Name, Last Name, Language, Time Zone.

Middle Name is optional.

## Normalization
1. Trim leading/trailing spaces.
2. Normalize repeated spaces.
3. Lowercase email for comparison.
4. Normalize phone to `+94` format.
5. Normalize Time Zone to `Asia/Colombo`.
6. Normalize accepted Language codes to canonical language names.
7. Do not silently change invalid Birth Date, Gender, Name, or Location values.
8. Missing mandatory fields are blocked.
