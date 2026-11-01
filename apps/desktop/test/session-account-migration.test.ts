import { expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateSessionAccounts } from '../src/main/session-account-migration';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE openai_account_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE openai_accounts (id TEXT PRIMARY KEY, name TEXT, proxy_mode TEXT, created_at TEXT, updated_at TEXT, auth_json TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, runtime_config_json TEXT);
    CREATE TABLE workflow_settings (key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE schedule_definitions (id TEXT PRIMARY KEY, data TEXT);`);
  return db;
}
const auth = (id: string, stamp: string, token = 'access') => JSON.stringify({
  last_refresh: stamp, tokens: { account_id: id, access_token: token, refresh_token: 'refresh' },
});
const setting = (db: DatabaseSync, key: string, value: string) => db.prepare(
  'INSERT INTO openai_account_settings VALUES (?, ?, ?)').run(key, value, 'before');
const model = { providerId: 'openai', modelId: 'gpt-test', thinkingEffort: 'low' };

test('migration freezes previous global identity in threads, defaults and schedules, preserving explicit accounts', () => {
  const db = database();
  try {
    setting(db, 'active_account_id', 'oa_previous');
    const config = { orchestrationSelection: { mainModel: model },
      resolvedOrchestrationSnapshot: { mainAgent: { modelRef: model } } };
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('old', JSON.stringify(config));
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('pinned', JSON.stringify({
      orchestrationSelection: { mainModel: { ...model, accountId: 'oa_other' } },
    }));
    db.prepare('INSERT INTO workflow_settings VALUES (?, ?)').run('default_orchestration_selection', JSON.stringify(config.orchestrationSelection));
    db.prepare('INSERT INTO schedule_definitions VALUES (?, ?)').run('schedule', JSON.stringify({ executionProfile: { runtimeConfig: config } }));
    migrateSessionAccounts(db, null);
    for (const [table, column] of [['threads', 'runtime_config_json'], ['workflow_settings', 'value_json'], ['schedule_definitions', 'data']]) {
      const rows = db.prepare(`SELECT ${column} AS json FROM ${table}`).all() as { json: string }[];
      expect(rows[0]!.json).toContain('oa_previous');
    }
    const pinned = db.prepare("SELECT runtime_config_json FROM threads WHERE id='pinned'").get() as { runtime_config_json: string };
    expect(pinned.runtime_config_json).toContain('oa_other');
    expect(db.prepare("SELECT 1 FROM openai_account_settings WHERE key='active_account_id'").get()).toBeUndefined();
    migrateSessionAccounts(db, null);
    expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toMatchObject({ n: 2 });
  } finally { db.close(); }
});

test('migration retains the freshest owned credentials and staged relogin, without publishing a global account', () => {
  const db = database();
  try {
    setting(db, 'active_account_id', 'oa_a');
    setting(db, 'pending_auth_account_id', 'oa_b');
    const staged = auth('remote-b', '2026-10-02T00:00:00Z', 'new-b');
    setting(db, 'pending_auth_json', staged);
    db.prepare('INSERT INTO openai_accounts (id,auth_json) VALUES (?,?)').run('oa_a', auth('remote-a', '2026-10-01T00:00:00.123456Z'));
    db.prepare('INSERT INTO openai_accounts (id,auth_json) VALUES (?,?)').run('oa_b', auth('remote-b', '2026-10-01T00:00:00Z'));
    const refreshed = auth('remote-a', '2026-10-01T00:00:00.123987Z', 'new-a');
    migrateSessionAccounts(db, refreshed);
    expect(db.prepare('SELECT auth_json FROM openai_accounts WHERE id=?').get('oa_a')).toMatchObject({ auth_json: refreshed });
    expect(db.prepare('SELECT auth_json FROM openai_accounts WHERE id=?').get('oa_b')).toMatchObject({ auth_json: staged });
    expect(db.prepare("SELECT key FROM openai_account_settings WHERE key LIKE 'pending_%'").all()).toEqual([]);
  } finally { db.close(); }
});

test('legacy unmanaged login becomes an explicit account for existing conversations', () => {
  const db = database();
  try {
    const raw = auth('unmanaged', '2026-10-01T00:00:00Z');
    db.prepare('INSERT INTO threads VALUES (?,?)').run('old', JSON.stringify({ mainModel: model }));
    migrateSessionAccounts(db, raw);
    const accounts = db.prepare('SELECT id,auth_json FROM openai_accounts').all() as {id:string; auth_json:string}[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.auth_json).toBe(raw);
    expect((db.prepare('SELECT runtime_config_json AS json FROM threads').get() as {json:string}).json).toContain(accounts[0]!.id);
  } finally { db.close(); }
});

test('migration rolls back invalid JSON before retiring the old selection', () => {
  const db = database();
  try {
    setting(db, 'active_account_id', 'oa_a');
    db.prepare('INSERT INTO threads VALUES (?,?)').run('broken', '{');
    expect(() => migrateSessionAccounts(db, null)).toThrow();
    expect(db.prepare("SELECT value FROM openai_account_settings WHERE key='active_account_id'").get()).toMatchObject({ value: 'oa_a' });
    expect(db.prepare("SELECT 1 FROM openai_account_settings WHERE key='session_accounts_v1'").get()).toBeUndefined();
  } finally { db.close(); }
});
