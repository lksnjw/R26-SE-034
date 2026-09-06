import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";

// Dedicated IPC fixture, never an application worker or an arbitrary RPC host.
if (!process.send || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== "demo-lcwe-records" || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded synthetic Firestore child requires the demo emulator and IPC");
let store, busy = false;
process.on("message", async message => {
  if (busy || !message || !["acquire", "assert", "close"].includes(message.command)) {
    process.send({ status: "denied" }); return;
  }
  busy = true;
  try {
    if (message.command === "acquire") {
      if (store || message.namespace?.projectId !== "demo-lcwe-records" || message.namespace?.databaseId !== "(default)" || !/^test_[a-f0-9]{32}_process$/.test(message.namespace?.workspaceId ?? "") || message.duration !== 5000)
        throw new Error("Invalid fixed fixture scope");
      store = FirestoreRecordStore.create(message.key, message.namespace);
      await store.acquireWriter({ duration: 5000 });
      const empty = await store.load(); if (empty.revision !== 0) throw new Error("Fixture namespace is not empty");
      await store.commit(empty, { transitionId: "child-initial-record", upsert: [{ profile: "runtime-record/v1", path: ["domain", "settings", "process"], value: "synthetic child answer" }] });
      store.assertWriterActive(); process.send({ status: "ready" });
    } else if (message.command === "assert") {
      store.assertWriterActive(); process.send({ status: "active" });
    } else {
      await store?.close(); process.send({ status: "closed" }); process.disconnect();
    }
  } catch { process.send({ status: "denied" }); }
  finally { busy = false; }
});

process.on("disconnect", () => { void store?.close().finally(() => { process.exit(0); }); });
