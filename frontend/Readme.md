
# ERP agent workspace frontend

The current workspace puts chat on the left and saved workflows on the right, stacking on narrow screens. Select a supported node or collection to propose edits in chat, review readable changes, then explicitly apply to a draft. Publication and execution are separate. Collection forms use Source list / Maximum items / Collected item; compiler issues remain visible rather than implying readiness.

Saved undo/redo and **Edit history** use server revision identities and survive browser reopening. Inspect historical settings/paths/nodes in a readable preview, then explicitly restore as a new draft. Memory-only deployments disclose server-restart data loss. Pending selected-node refresh keeps text and blocks Send instead of dropping into general chat.

**Arrange flow** exposes exact insertion points and previewed whole-subtree placement. Conditions/collections retain their contents; action/condition/return insertion uses readable forms. Apply saves only a draft. Unknown save responses require authoritative reload; stale retained previews cannot apply. See [structured canvas behavior and verification limits](../docs/STRUCTURED_CANVAS_PLACEMENT_2026-10-06.md).

See [saved history and local browser/Firestore evidence](../docs/DRAFT_EDIT_HISTORY_AND_RECOVERY_2026-10-06.md), [collection editing](../docs/COLLECTION_NODE_CHAT_AND_DRAFT_VALIDATION_2026-10-06.md), [Firebase Hosting plan](../docs/FIREBASE_STORAGE_AND_INTEGRATION_PLAN_2026-10-06.md) and [full completion status](../docs/PROJECT_COMPLETION_STATUS_2026-10-06.md). Existing authentication remains; the browser does not receive Firestore server credentials. Latest regression: 418 Jest tests, full detect-open-handles run, lint/build and 15 Hosting configuration/release checks passed. This is not production or full-agent acceptance. Images below are historical reference screenshots.

<img width="1912" height="896" alt="image" src="https://github.com/user-attachments/assets/26cd117e-3660-4080-ae95-46a3bec62b64" />

<img width="1915" height="903" alt="image" src="https://github.com/user-attachments/assets/496957c6-a8b1-4309-a2c0-33f43bec390c" />

<img width="1919" height="915" alt="image" src="https://github.com/user-attachments/assets/725661f7-42d0-4a8d-a3bc-23e04e42b592" />

