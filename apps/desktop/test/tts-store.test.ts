import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { DEFAULT_TTS_PROFILE_ID, type TtsSecretCodec, TtsStore } from "../src/main/tts-store";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const codec: TtsSecretCodec = {
  isAvailable: () => true,
  encrypt: (key) => `encrypted:${key}`,
  decrypt: (key) => key.slice(10),
};
function fixture(customCodec: TtsSecretCodec = codec) {
  const db = new Database(":memory:");
  databases.push(db);
  const store = new TtsStore(db as never, customCodec);
  store.initialize();
  return { db, store };
}
function configure(store: TtsStore) {
  const initial = store.getSettings().profiles[0]!;
  return store.saveProfile({ ...initial, apiKey: "secret-key" });
}

test("TTS defaults to Gemini 3.8, stays disabled until configured, and never exposes secrets", () => {
  const { store, db } = fixture();
  const initial = store.getSettings();
  expect(initial.enabled).toBe(false);
  expect(initial.profiles[0]).toMatchObject({
    provider: "gemini",
    model: "gemini-3.8-flash-tts",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    hasApiKey: false,
  });
  expect(() => store.setEnabled(true)).toThrow("API Key");
  const profile = configure(store);
  expect(profile.hasApiKey).toBe(true);
  expect(JSON.stringify(store.getSettings())).not.toContain("secret-key");
  expect(db.prepare("SELECT encrypted_api_key FROM tts_profiles").get()).toEqual({
    encrypted_api_key: "encrypted:secret-key",
  });
  expect(store.setEnabled(true).enabled).toBe(true);
});

test("profiles retain a custom base URL and model, preserve saved keys and enforce activation/deletion", () => {
  const { store } = fixture();
  configure(store);
  const router = store.saveProfile({
    name: "Router",
    provider: "openai_compatible",
    model: "google/gemini-3.8-flash-tts",
    baseUrl: "https://proxy.example/custom/api/v1/",
    apiKey: "router-secret",
  });
  store.saveProfile({ ...router, name: "Router edited", baseUrl: "https://proxy.example/other/v1" });
  store.activateProfile(router.id);
  expect(store.getActiveClientConfig()).toMatchObject({
    profileName: "Router edited",
    baseUrl: "https://proxy.example/other/v1",
    apiKey: "router-secret",
  });
  expect(() => store.deleteProfile(router.id)).toThrow("激活");
  expect(() => store.saveProfile({ ...router, id: undefined, name: "Router edited" })).toThrow("名称已存在");
});

test("invalid URLs, protocols and unavailable secret storage fail explicitly", () => {
  const { store } = fixture({ ...codec, isAvailable: () => false });
  const profile = store.getSettings().profiles[0]!;
  for (const baseUrl of [
    "",
    "file:///tmp/tts",
    "https://example.com/v1?key=secret",
    "https://user:secret@example.com/v1",
  ])
    expect(() => store.saveProfile({ ...profile, baseUrl })).toThrow();
  expect(() => store.saveProfile({ ...profile, provider: "invalid" } as never)).toThrow();
  expect(() => store.saveProfile({ ...profile, apiKey: "secret" })).toThrow("系统加密不可用");
});

test("doubao profiles keep the Volcengine endpoint and resource ID", () => {
  const { store } = fixture();
  configure(store);
  const profile = store.saveProfile({
    name: "豆包 TTS 2.0",
    provider: "doubao",
    baseUrl: "https://openspeech.bytedance.com",
    model: "seed-tts-2.0",
    apiKey: "doubao-secret",
  });
  store.activateProfile(profile.id);
  expect(store.getActiveClientConfig()).toMatchObject({
    provider: "doubao",
    baseUrl: "https://openspeech.bytedance.com",
    model: "seed-tts-2.0",
    apiKey: "doubao-secret",
  });
});

test("legacy provider CHECK migration keeps profiles and accepts doubao", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tts_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    provider TEXT NOT NULL CHECK(provider IN ('gemini', 'openai_compatible')),
    baseUrl TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tts_settings (singleton INTEGER PRIMARY KEY, enabled INTEGER NOT NULL,
    active_profile_id TEXT NOT NULL REFERENCES tts_profiles(id), updated_at TEXT NOT NULL);`);
  const id = DEFAULT_TTS_PROFILE_ID;
  db.prepare(
    "INSERT INTO tts_profiles VALUES (?, 'Legacy', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3.8-flash-tts', ?, 'created', 'updated')",
  ).run(id, codec.encrypt("legacy-secret"));
  db.prepare("INSERT INTO tts_settings VALUES (1, 1, ?, 'updated')").run(id);
  const store = new TtsStore(db as never, codec);
  store.initialize();
  expect(store.getActiveClientConfig()).toMatchObject({ profileId: id, apiKey: "legacy-secret" });
  const doubao = store.saveProfile({
    name: "Doubao",
    provider: "doubao",
    baseUrl: "https://openspeech.bytedance.com",
    model: "seed-tts-2.0",
    apiKey: "doubao-secret",
  });
  store.activateProfile(doubao.id);
  expect(store.getActiveClientConfig().provider).toBe("doubao");
});

test("artifacts survive reopening, remain thread-scoped and interrupted generations become failures", () => {
  const { store, db } = fixture();
  configure(store);
  const config = store.getActiveClientConfig();
  const first = store.createArtifact({
    threadId: "thread-a",
    toolUseId: "tool-a",
    text: "你好",
    parameters: { voice: "Kore", style: "温暖" },
    config,
    workspacePath: "/tmp/work",
    generationRoot: "/tmp/work",
  });
  const second = store.createArtifact({
    threadId: "thread-b",
    text: "Goodbye",
    parameters: { voice: "Puck", style: "cheerful" },
    config,
    workspacePath: "/tmp/work",
    generationRoot: "/tmp/work",
  });
  const audio = [
    {
      absolutePath: "/tmp/work/.eco/generated-audio/test.wav",
      relativePath: ".eco/generated-audio/test.wav",
      mimeType: "audio/wav",
      bytes: 52,
    },
  ];
  store.completeArtifact(first.id, audio);
  const reopened = new TtsStore(db as never, codec);
  reopened.initialize();
  expect(reopened.listArtifacts("thread-a")).toHaveLength(1);
  expect(reopened.getArtifact(first.id)).toMatchObject({
    status: "completed",
    toolUseId: "tool-a",
    text: "你好",
    parameters: { voice: "Kore", style: "温暖" },
    audio,
  });
  expect(reopened.getArtifact(second.id)).toMatchObject({ status: "failed", errorCode: "interrupted" });
  db.prepare("UPDATE tts_artifacts SET parameters_json = ? WHERE id = ?").run("corrupt-json", first.id);
  expect(() => reopened.getArtifact(first.id)).toThrow();
});
