import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const migrationKey = "session_accounts_v1";
const obsoleteKeys = ["active_account_id", "pending_account_id", "pending_delete_ids",
  "pending_auth_account_id", "pending_auth_json", "last_published_fingerprint"];

function identity(raw: string): string | undefined {
  const auth = JSON.parse(raw);
  return auth.tokens?.account_id ?? auth.account_id;
}

function stamp(raw: string): string {
  const value = JSON.parse(raw).last_refresh;
  // ISO timestamps are normalized to microseconds before comparing.
  if (typeof value !== "string") return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d{2}:?\d{2}$)/i)?.[1] ?? "";
  return String(ms * 1_000 + Number(fraction.slice(3, 6).padEnd(3, "0"))).padStart(18, "0");
}

/** Preserve the previous choice on existing conversations, then retire global selection. */
export function migrateSessionAccounts(db: DatabaseSync, mainAuth: string | null): void {
  const setting = (key: string) => (db.prepare("SELECT value FROM openai_account_settings WHERE key = ?")
    .get(key) as { value: string } | undefined)?.value;
  if (setting(migrationKey) === "complete") return;
  let activeId = setting("active_account_id")?.trim();
  const stagedId = setting("pending_auth_account_id");
  const stagedAuth = setting("pending_auth_json");
  if (Boolean(stagedId) !== Boolean(stagedAuth)) throw new Error("旧账号待保存凭据不完整，无法迁移。");
  db.exec("BEGIN IMMEDIATE");
  try {
    // The retired single-login screen could leave credentials without an account row.
    // Import that exact identity instead of selecting an arbitrary managed account.
    if (!activeId && mainAuth) {
      const auth = JSON.parse(mainAuth);
      const tokens = auth.tokens ?? auth;
      const chatgptId = identity(mainAuth);
      if (typeof chatgptId === "string" && typeof tokens.access_token === "string" && tokens.access_token) {
        activeId = `oa_legacy_${createHash("sha256").update(chatgptId).digest("hex").slice(0, 16)}`;
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO openai_accounts (id, name, proxy_mode, created_at, updated_at, auth_json)
          VALUES (?, 'ChatGPT Login', 'system', ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
          .run(activeId, now, now, mainAuth);
      }
    }
    if (activeId && mainAuth) {
      const account = db.prepare("SELECT auth_json FROM openai_accounts WHERE id = ?").get(activeId) as
        { auth_json: string | null } | undefined;
      if (account && (!account.auth_json || identity(account.auth_json) === identity(mainAuth))) {
        if (!account.auth_json || stamp(mainAuth) > stamp(account.auth_json)) {
          db.prepare("UPDATE openai_accounts SET auth_json = ? WHERE id = ?").run(mainAuth, activeId);
        }
      }
    }
    if (stagedId && stagedAuth) {
      const updated = db.prepare("UPDATE openai_accounts SET auth_json = ? WHERE id = ?").run(stagedAuth, stagedId);
      if (!Number(updated.changes)) throw new Error("旧账号待保存凭据对应的账号不存在。");
    }
    if (activeId) {
      for (const [table, key, column] of [
        ["workflow_settings", "key", "value_json"],
        ["project_orchestration_settings", "workspace_path", "selection_json"],
        ["threads", "id", "runtime_config_json"],
        ["schedule_definitions", "id", "data"],
        ["schedule_occurrences", "id", "data"],
      ]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table!)) continue;
        const rows = db.prepare(`SELECT ${key} AS id, ${column} AS json FROM ${table} WHERE ${column} IS NOT NULL`)
          .all() as Array<{ id: string; json: string }>;
        for (const row of rows) {
          const value = JSON.parse(row.json);
          if (bindAccount(value, activeId)) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`)
            .run(JSON.stringify(value), row.id);
        }
      }
    }
    const deletes = JSON.parse(setting("pending_delete_ids") || "[]") as string[];
    if (!Array.isArray(deletes) || deletes.some((id) => typeof id !== "string")) throw new Error("旧账号待删除设置损坏。");
    for (const id of deletes) db.prepare("DELETE FROM openai_accounts WHERE id = ?").run(id);
    for (const key of obsoleteKeys) db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(key);
    db.prepare("INSERT INTO openai_account_settings (key, value, updated_at) VALUES (?, 'complete', ?)")
      .run(migrationKey, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function bindAccount(value: unknown, accountId: string): boolean {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  const object = value as Record<string, unknown>;
  if (object.providerId === "openai" && typeof object.modelId === "string" && !object.accountId) {
    object.accountId = accountId;
    changed = true;
  }
  for (const child of Object.values(object)) if (bindAccount(child, accountId)) changed = true;
  return changed;
}
