import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  conversationV2EventHash,
  inspectSdkInformationalEventHashRepair,
} from "../src/main/conversation-v2-event-integrity";
import { conversationV2ProviderReceipt } from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { removeTempDirectorySync } from "./helpers/temp-directory";

function fixture(filename = ":memory:", metadata = { level: "warning", tag: undefined }) {
  const db = new DatabaseSync(filename);
  const v2 = new ConversationV2Store(db);
  v2.initialize();
  const input = conversationV2ProviderReceipt(
    {
      threadId: "thread",
      id: "sdk-notice",
      eventType: "diagnostic",
      scope: "main",
      role: "system",
      streamState: "none",
      message: "Provider warning",
      observedAt: "2026-10-12T06:10:12.033Z",
      sequence: 0,
      metadata: { activityOrigin: "sdk.informational", liveType: "sdk.notice", ...metadata },
    },
    "runtime-input",
    { includeMessageId: false },
  );
  const result = v2.append(input);
  const previousHash = conversationV2EventHash(input);
  db.prepare("UPDATE conversation_events_v2 SET event_hash = ? WHERE seq = 1").run(previousHash);
  return {
    db,
    v2,
    event: { ...result.event, eventHash: previousHash },
    correctedHash: result.event.eventHash,
  };
}

test("repair requires the exact historical hash of missing SDK informational level/tag", () => {
  const { db, event, correctedHash } = fixture();
  try {
    const before = JSON.stringify(event);
    expect(inspectSdkInformationalEventHashRepair(event)).toEqual({
      previousHash: event.eventHash,
      correctedHash,
      omittedMetadataKeys: ["tag"],
    });
    expect(JSON.stringify(event)).toBe(before);
    expect(inspectSdkInformationalEventHashRepair({ ...event, eventHash: correctedHash })).toBeUndefined();
    expect(inspectSdkInformationalEventHashRepair({ ...event, eventHash: "deadbeef" })).toBeUndefined();
    expect(
      inspectSdkInformationalEventHashRepair({ ...event, payload: { ...event.payload, reason: "tampered" } }),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

test("repair also proves both omitted informational fields without inventing their values", () => {
  const { db, event } = fixture(":memory:", { level: undefined, tag: undefined } as never);
  try {
    expect(inspectSdkInformationalEventHashRepair(event)?.omittedMetadataKeys).toEqual(["level", "tag"]);
  } finally {
    db.close();
  }
});

function buildCli(directory: string) {
  const source = fileURLToPath(new URL("../scripts/conversation-v2-repair-event-hash.ts", import.meta.url));
  const outfile = join(directory, "repair.mjs");
  const built = spawnSync("bun", ["build", source, "--target=node", `--outfile=${outfile}`], {
    encoding: "utf8",
  });
  expect(built.status).toBe(0);
  return (filename: string, ...flags: string[]) =>
    spawnSync("node", [outfile, "--db", filename, "--conversation", "thread", "--seq", "1", ...flags], {
      encoding: "utf8",
    });
}

test("Node CLI inspects without mutation, backs up, repairs only the hash and records evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-event-hash-repair-"));
  const filename = join(directory, "store.sqlite");
  const backup = join(directory, "backup.sqlite");
  try {
    const { db } = fixture(filename);
    const event = db.prepare("SELECT * FROM conversation_events_v2").get();
    if (!event) throw new Error("Fixture event is missing.");
    const effect = db.prepare("SELECT * FROM conversation_sync_effects_v2").get();
    const stream = db.prepare("SELECT * FROM conversation_streams_v2").get();
    db.close();
    const cli = buildCli(directory);
    const bytes = readFileSync(filename);
    const inspected = cli(filename);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).repair.omittedMetadataKeys).toEqual(["tag"]);
    expect(readFileSync(filename)).toEqual(bytes);
    const applied = cli(filename, "--apply", "--backup", backup);
    expect(applied.status).toBe(0);
    const result = JSON.parse(applied.stdout);
    const repaired = new DatabaseSync(filename);
    try {
      expect(repaired.prepare("SELECT * FROM conversation_events_v2").get()).toEqual({
        ...event,
        event_hash: result.repair.correctedHash,
      });
      expect(repaired.prepare("SELECT * FROM conversation_sync_effects_v2").get()).toEqual(effect);
      expect(repaired.prepare("SELECT * FROM conversation_streams_v2").get()).toEqual(stream);
      expect(
        repaired
          .prepare(
            "SELECT previous_hash, corrected_hash, omitted_metadata_keys_json FROM conversation_event_hash_repairs_v2",
          )
          .get(),
      ).toEqual({
        previous_hash: event.event_hash,
        corrected_hash: result.repair.correctedHash,
        omitted_metadata_keys_json: '["tag"]',
      });
      expect(new ConversationV2Store(repaired).validateIntegrity("thread").headSeq).toBe(1);
    } finally {
      repaired.close();
    }
    const saved = new DatabaseSync(backup, { readOnly: true });
    try {
      expect(saved.prepare("SELECT * FROM conversation_events_v2").get()).toEqual(event);
    } finally {
      saved.close();
    }
    expect(JSON.parse(cli(filename).stdout).repair).toBeNull();
  } finally {
    removeTempDirectorySync(directory);
  }
});

test("Node CLI refuses unrelated corruption and leaves the database unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-event-hash-refuse-"));
  const filename = join(directory, "store.sqlite");
  try {
    const { db } = fixture(filename);
    db.prepare("UPDATE conversation_events_v2 SET event_hash = 'deadbeef'").run();
    const before = db.prepare("SELECT * FROM conversation_events_v2").get();
    db.close();
    const failed = buildCli(directory)(filename, "--apply", "--backup", join(directory, "backup.sqlite"));
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("refusing repair");
    const reopened = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(reopened.prepare("SELECT * FROM conversation_events_v2").get()).toEqual(before);
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_event_hash_repairs_v2'")
          .get(),
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    removeTempDirectorySync(directory);
  }
});

test("Node CLI refuses a proven event repair when the conversation effects are damaged", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-event-hash-effect-refuse-"));
  const filename = join(directory, "store.sqlite");
  try {
    const { db } = fixture(filename);
    db.prepare("UPDATE conversation_sync_effects_v2 SET effect_hash = 'deadbeef'").run();
    const before = db.prepare("SELECT * FROM conversation_events_v2").get();
    db.close();
    const failed = buildCli(directory)(filename, "--apply", "--backup", join(directory, "backup.sqlite"));
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("Effect integrity failure");
    const reopened = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(reopened.prepare("SELECT * FROM conversation_events_v2").get()).toEqual(before);
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_event_hash_repairs_v2'")
          .get(),
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    removeTempDirectorySync(directory);
  }
});
