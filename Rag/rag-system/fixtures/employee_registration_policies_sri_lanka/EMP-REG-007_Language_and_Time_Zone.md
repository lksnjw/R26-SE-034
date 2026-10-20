# EMP-REG-007 — Language and Time Zone Validation Policy

## Language
Supported values:
- English
- Sinhala
- Tamil

Codes may be normalized:
- `en` -> English
- `si` -> Sinhala
- `ta` -> Tamil

Other language values are blocked unless the supported-language configuration is updated.

## Time Zone
1. Time Zone is mandatory.
2. The canonical value is `Asia/Colombo`.
3. `UTC+05:30` may be normalized to `Asia/Colombo` only if the application supports that mapping.
4. Foreign time zones are blocked.
