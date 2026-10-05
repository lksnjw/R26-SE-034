import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hashPassword, verifyPassword } from "../src/authn/password.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";

// Narrow repair/inspection of this unique generated browser fixture only.
// Never load owner environment files, use ADC or reset an existing password.
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
const session = JSON.parse(await readFile(".functions/qa-session.json", "utf8")), config = session.config;
assert.equal(session.profile, "lcwe-native-functions-qa/v1");
assert(
  ["native-operation/v1", "native-read/v1", "native-scale/v1"].includes(config.LCWE_LOCAL_DOCKER_QA),
  "Only the guarded native operation/read/scale fixtures may be inspected",
);
assert.equal(config.CORS_ORIGINS, "http://127.0.0.1:5192,http://localhost:5192");
assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records"); assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
const repository = await Repository.open(await FirestoreRecordPersistence.open(config.STORAGE_ENCRYPTION_KEY,
  { projectId: config.FIRESTORE_PROJECT_ID, databaseId: config.FIRESTORE_DATABASE_ID, workspaceId: config.FIRESTORE_WORKSPACE_ID }));
try {
  if (process.argv[2] === "--repair-legacy-fixture-login") {
    const prior = await repository.snapshot();
    for (const [id, email, role] of [["native_owner", "native@example.test", "role_admin"], ["native_reviewer", "reviewer@example.test", "native_review"]]) {
      const user = prior.users[id]; assert.equal(user?.email, email); assert.equal(user.roleId, role);
      assert.equal(prior.passwordHashes[id], undefined, "Existing password hash is preserved; this is not a password reset");
      assert(await verifyPassword(user.passwordHash ?? "", "Synthetic-local-only-2026!"), "Only the exact legacy synthetic fixture can be repaired");
    }
    const hash = await hashPassword("Synthetic-local-only-2026!");
    await repository.mutate(state => {
      for (const id of ["native_owner", "native_reviewer"]) {
        assert.equal(state.passwordHashes[id], undefined); state.passwordHashes[id] = hash; delete state.users[id].passwordHash;
      }
    });
    console.log("PASS: moved only the two exact legacy synthetic fixture logins into the existing private password store; no production auth or existing private password reset");
  } else if (process.argv[2] === "--inspect") {
    const state = await repository.snapshot();
    console.log(JSON.stringify({ executions: Object.values(state.executions).map(run => ({ id: run.id, workflowId: run.workflowId, status: run.status,
      publishedVersion: run.workflowSnapshot?.version, nodeIds: Object.keys(run.stepOutputs ?? {}), events: state.executionEvents[run.id]?.length ?? 0,
      generations: run.operationSecret?.taskDispatchSecret?.generations.map(value => ({ ordinal: value.ordinal, state: value.state, milestone: value.completion?.milestone })) ?? [] })),
      workflows: Object.values(state.workflows).map(flow => ({ id: flow.id, version: flow.draftVersion, published: flow.publishedVersion })),
      chats: Object.values(state.chats).map(chat => ({ id: chat.id, messages: chat.messages.length })),
      operations: Object.values(state.chatOperations).map(op => ({ id: op.id, status: op.status })) }));
  } else throw new Error("Choose --repair-legacy-fixture-login or --inspect explicitly");
} finally { await repository.close(); }
