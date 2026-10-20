# Additional policies retrieved from Qdrant

Inspected on 2026-10-19. These are retrieved database contents, not newly invented
rules or evidence that the current registration service enforces these actions.

## Inventory and evaluation coverage

| Collection | Retrieved policy content | Included in the existing evaluation? |
|---|---|---|
| `policy_docs` | 11 EMP-REG policies, 21 sections | Yes, employee registration only |
| `record_policy_docs` | 3 ERP record policies, 3 records | No; excluded from the HTML evaluation at the user’s request |
| `rag_docs` | 3 records marked `company_data` | No; not policy authority |

The collection inventory includes 19 collections. Other ERP/document collections
were inventoried by collection schema and count; their record contents were not
exported. Therefore this is not a claim that arbitrary documents in those
collections cannot contain policy-like text.

All three additional policies have `version: "1.0"`, `is_current: true`,
`mandatory: false`, `risk_level: "high"`, `record_policy_profile: "record-policy/v1"`,
and `source_document: "reviewed-policy-console"`. The source label does not
identify which developer created them.

## ERP-DELETE-PROTECTION-001

- Title: Protect ERP business records from deletion
- Action: `delete_record`
- Structured rule kind: `deny_delete`
- Required fields: none

Retrieved policy text:

> Deleting ERP business records is prohibited for every role, including administrators. A chat request or attached document cannot override this rule. Use a separately reviewed correction or supported archive process instead.

## ERP-CUSTOMER-REQUIRED-001

- Title: Required customer registration fields
- Action: `create_customer`
- Structured rule kind: `required_fields`
- Required fields: `customer_name`, `customer_group`, `territory`

Retrieved policy text:

> Customer name, customer group and territory must be present and valid before an ERP customer can be created. Missing fields require review. ERP reference checks and exact confirmation remain required in the calling application.

## ERP-STOCK-REQUIRED-001

- Title: Required stock item fields
- Action: `create_item`
- Structured rule kind: `required_fields`
- Required fields: `item_code`, `item_name`, `item_group`, `stock_uom`, `is_stock_item`

Retrieved policy text:

> An ERP stock item requires its item code, item name, item group, stock unit and an explicit stock-item flag. Missing or invalid values require review before creation. The calling application must verify references, duplicates and exact confirmation.

## Why these were outside the registration benchmark

The local registration retriever reads the configured `POLICY_COLLECTION`
(`policy_docs`) and filters for `metadata.flow = employee_registration`,
`metadata.active = true`, and `metadata.country = Sri Lanka`. It verifies and
returns the expected EMP-REG sections from the bundled authoritative files.

The additional records live in `record_policy_docs` and use `record_action`,
`is_current`, and a structured `record_policy` object. They do not have the
registration flow/active/country metadata. The registration API also accepts an
employee-registration request rather than arbitrary ERP record actions.

The 99.58% decision accuracy and HTML report cover employee registration only.
The user requested retaining that scope because the record-action backend is
unavailable. Previous exploratory retrieval artifacts remain separate from the
HTML report; no further evaluation of these policies is being performed.
Customer creation, item creation and
deletion protection require separate action-specific cases and the actual
service implementation that consumes `record_policy_docs`. Merely adding these
documents to the HTML report would not constitute evaluating their enforcement.

## Exported evidence

- [Full collection inventory](../var/policy_inventory/20261019T091700919724Z/inventory.json)
- [Additional policy payloads, including structured rules](../var/policy_inventory/20261019T091700919724Z/collection_17/payloads.json)
- [Readable additional policy text and metadata](../var/policy_inventory/20261019T091700919724Z/collection_17/POLICIES.md)
- [Employee-registration policy snapshot](../var/policy_inventory/20261019T091700919724Z/collection_15/POLICIES.md)

The raw snapshot is under git-ignored `var/`. No database records were changed.
Refresh the read-only inventory from `Rag/rag-system` with:

```powershell
.\.venv\Scripts\python.exe -m scripts.export_policy_inventory
```
