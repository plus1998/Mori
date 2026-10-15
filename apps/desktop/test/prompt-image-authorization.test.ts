import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const REF_A = `sha256:${"a".repeat(64)}`;
const REF_B = `sha256:${"b".repeat(64)}`;

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
  store.initialize();
  return store;
}

test("staged composer images are readable from a thread draft that owns them", () => {
  const store = harness();
  store.saveComposerDraft("thread:t1", "", [{ mediaType: "image/png", contentRef: REF_A }]);

  expect(store.isPromptImageContentRefAuthorized("thread:t1", REF_A)).toBe(true);
});

test("staged composer images are readable from a landing draft that owns them", () => {
  const store = harness();
  store.saveComposerDraft("landing:/tmp/project", "", [
    { mediaType: "image/png", contentRef: REF_A },
  ]);

  expect(store.isPromptImageContentRefAuthorized("landing:/tmp/project", REF_A)).toBe(true);
});

test("authorization stays scoped to the owning draft", () => {
  const store = harness();
  store.saveComposerDraft("thread:t1", "", [{ mediaType: "image/png", contentRef: REF_A }]);

  expect(store.isPromptImageContentRefAuthorized("thread:t2", REF_A)).toBe(false);
  expect(store.isPromptImageContentRefAuthorized("landing:/tmp/project", REF_A)).toBe(false);
  expect(store.isPromptImageContentRefAuthorized("thread:t1", REF_B)).toBe(false);
  expect(store.isPromptImageContentRefAuthorized("other:t1", REF_A)).toBe(false);
});
