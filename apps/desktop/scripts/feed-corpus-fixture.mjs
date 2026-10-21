/**
 * Builds the Feed-parity corpus fixture from a local Eco database.
 *
 * The Feed's correctness is defined by the old chain's output on *real* rows, so the
 * regression net has to run on real shapes rather than hand-written ones. Committing a
 * chat database is not an option, so this writes a corpus with the same structure — the
 * same event types, scopes, roles, owners, stream identities, tool names, metadata keys
 * and times — and free text replaced by deterministic placeholders. The differential
 * compares two renderings of that corpus, so replacing prose does not weaken it: the
 * shapes, not the words, are what the two chains have to agree on. (Wording differences
 * are tracked separately in `docs/plans/feed-regression-test-plan.md`.)
 *
 * Usage:
 *   bun apps/desktop/scripts/feed-corpus-fixture.mjs <sqlite-path> [conversation-id ...]
 *
 * Without ids it picks the conversations listed in DEFAULT_CONVERSATIONS below, which
 * between them cover subagents with task names, an abandoned agent, thinking rows,
 * provider progress/heartbeat rows and failure notices (api.error/request.failed), retries,
 * 5-attempt runs and never-migrated conversations (the cold-migration path).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const DEFAULT_CONVERSATIONS = [
  "thr_1789558307403",
  "thr_1789559379858",
  "thr_1789559384838",
  "thr_1789542050047",
  "thr_1789531481908",
  "thr_1788751566714",
  // Added 2026-09-17 from the real-database inventory (`bun run feed:v2-inventory`): the
  // conversations whose two chains render differently, so the classification is what decides
  // whether the difference is a product-non-content class or a lost row.
  "thr_1789537718627",
  "thr_1788608485610",
  "thr_1789133041817",
];

/**
 * Metadata string keys that steer behaviour rather than describe content. They must keep
 * their real values: replacing `liveType` would change which branch the legacy projector
 * takes, and the fixture would stop testing anything.
 */
const STRUCTURAL_METADATA_KEYS = new Set([
  "agentId",
  "agentInstanceId",
  "bashApproval",
  "claudeToolUseId",
  "descriptionHash",
  "detailType",
  "kind",
  "liveType",
  "missionId",
  "model",
  "name",
  "parentAgentId",
  "parentToolUseId",
  "phase",
  "requestId",
  "role",
  "sdkTaskId",
  "sdkTaskKind",
  "status",
  "streamKey",
  "thinkingStartedAt",
  "todoId",
  "toolName",
  "toolUseId",
  "type",
]);

const argv = process.argv.slice(2);
const dbPath = argv.find((argument) => !argument.startsWith("--"));
if (!dbPath) {
  console.error("usage: bun apps/desktop/scripts/feed-corpus-fixture.mjs <sqlite-path> [conversation-id ...]");
  process.exit(2);
}
const conversations = argv.filter((argument) => argument !== dbPath);
const selected = conversations.length > 0 ? conversations : DEFAULT_CONVERSATIONS;

const db = openDatabaseForReading(dbPath);

/**
 * The database, opened without writing to it.
 *
 * `node:sqlite` cannot open a WAL database read-only: the read-only handle has no `-shm`
 * file and SQLite will not create one for it, so the open fails with "unable to open
 * database file" — a fixture generator that only works while the user's app happens to be
 * running. The database is copied to a temporary directory instead and the *copy* is opened
 * for reading and writing: nothing here writes, and the user's storage is left alone.
 */
function openDatabaseForReading(path) {
  const directory = mkdtempSync(join(tmpdir(), "eco-corpus-"));
  const copy = join(directory, basename(path));
  copyFileSync(path, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
  }
  return new DatabaseSync(copy);
}

/**
 * A content-addressed placeholder: the same text always becomes the same token, so the
 * differential can still tell "this row says the same thing on both sides" from "this row
 * changed" — and the same prompt written into two tables (a user message row and the event
 * that reports it) stays recognisably the same text. A counter would have made every copy
 * of one sentence look like a different sentence.
 */
function placeholder(key, value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const shape = value.length === 0 ? "empty" : `len${Math.min(value.length, 999)}`;
  return `<${key}#${digest}:${shape}>`;
}

function scrubString(key, value) {
  if (STRUCTURAL_METADATA_KEYS.has(key)) return value;
  return placeholder(key, value);
}

/**
 * Keeps the shape of the provider's tool line (`Tool: Bash · <detail>`) because both
 * chains parse the prefix for the tool's name and take the rest as its detail.
 */
/**
 * Short, app-generated status lines (`运行中`, `已停止`, ...) are kept verbatim: they say
 * nothing about the user, and the Feed is supposed to *classify* them (the operational
 * status patterns) rather than render them — a placeholder would make that untestable.
 */
function scrubStatusLine(message) {
  const trimmed = message.trim();
  if (trimmed.length > 0 && trimmed.length <= 40) return message;
  return scrubMessage(message);
}

function scrubMessage(message) {
  const match = message.match(/^((?:Tool|工具(?:调用)?)\s*[:：]\s*[\w.-]+)(\s*[·|]\s*)?([\s\S]*)$/);
  if (match) {
    return `${match[1]}${match[2] ?? ""}${match[3] ? placeholder("detail", match[3]) : ""}`;
  }
  return message.trim() ? placeholder("text", message) : message;
}

/**
 * Keys whose values are unbounded content dumps. Their shape is kept as a count so the
 * fixture still says "this row carried a diff of N lines" without carrying the lines —
 * a 69k-line diff preview is exactly what the read path is supposed to bound, and it is
 * not what the two chains are compared on.
 */
const UNBOUNDED_KEYS = new Set(["previewLines", "patch", "diff", "sections"]);
/** Arrays are capped so one artifact cannot dominate the fixture; the cap is recorded. */
const MAX_ARRAY_ITEMS = 6;

function scrubValue(value, key, depth) {
  if (typeof value === "string") return scrubString(key, value);
  if (Array.isArray(value)) {
    if (UNBOUNDED_KEYS.has(key)) return [`<${key}#${value.length}>`];
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (UNBOUNDED_KEYS.has(childKey) && !Array.isArray(childValue)) continue;
      out[childKey] = scrubValue(childValue, childKey, depth + 1);
    }
    return out;
  }
  // Numbers and booleans are bounded and carry no prose.
  return value;
}

function scrubMetadata(json) {
  if (!json) return json;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return JSON.stringify(scrubValue(parsed, "metadata", 0));
}

function rows(table, where, ...args) {
  return db.prepare(`SELECT * FROM ${table} ${where}`).all(...args);
}

const corpus = {
  generatedFrom: "local Eco dev database (thread rows, structure only)",
  generatedBy: "apps/desktop/scripts/feed-corpus-fixture.mjs",
  anonymized: true,
  conversations: [],
};

for (const conversationId of selected) {
  const thread = db
    .prepare(`SELECT * FROM threads WHERE id = ?`)
    .get(conversationId);
  if (!thread) {
    console.error(`skipping ${conversationId}: not found`);
    continue;
  }
  const attempts = db
    .prepare(`SELECT * FROM thread_run_attempts WHERE thread_id = ? ORDER BY started_at ASC, attempt_id ASC`)
    .all(conversationId)
    .map((row) => ({ ...row }));
  const agents = db
    .prepare(`SELECT * FROM thread_agent_instances WHERE thread_id = ? ORDER BY started_at ASC, agent_id ASC`)
    .all(conversationId)
    .map((row) => ({ ...row }));
  const events = db
    .prepare(`SELECT * FROM thread_run_events WHERE thread_id = ? ORDER BY sequence ASC, id ASC`)
    .all(conversationId)
    .map((row) => {
      const isStatusLine = row.event_type === "thread.status" && row.role === "system";
      return {
        ...row,
        message: isStatusLine
          ? scrubStatusLine(String(row.message ?? ""))
          : scrubMessage(String(row.message ?? "")),
        metadata_json: scrubMetadata(row.metadata_json),
      };
    });
  const users = rows("thread_user_messages", "WHERE thread_id = ? ORDER BY created_at ASC", conversationId).map(
    (row) => ({ ...row, text: scrubMessage(String(row.text ?? "")) }),
  );
  // The whole thread row: the test inserts it back into a fresh database, so every NOT
  // NULL column has to be there. Prose columns are scrubbed like any other free text.
  const threadRow = {};
  for (const [key, value] of Object.entries(thread)) {
    // `id` is a key other rows point at, not prose: it has to survive, or every foreign
    // key into the conversation breaks.
    const structural = key === "id" || key === "status" || key === "core_kind";
    threadRow[key] = typeof value === "string" && !structural ? placeholder(key, value) : value;
  }
  corpus.conversations.push({
    conversationId,
    thread: threadRow,
    attempts,
    agents,
    events,
    users,
  });
  console.error(
    `corpus ${conversationId}: events=${events.length} attempts=${attempts.length} agents=${agents.length} users=${users.length}`,
  );
}

const target = new URL("../test/fixtures/feed-parity/conversation-corpus.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(corpus, null, 1)}\n`);
console.error(`wrote ${target.pathname}`);
