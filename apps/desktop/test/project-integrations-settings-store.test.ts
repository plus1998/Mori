import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDirectory } from "./helpers/temp-directory";
import { ProjectIntegrationsSettingsStore } from "../src/main/project-integrations-settings-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTempDirectory(directory)),
  );
});

async function createDatabase(browserEnabled = true): Promise<{ dbPath: string; workspacePath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-integrations-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "settings.sqlite");
  const workspacePath = path.join(directory, "workspace");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE project_mcp_settings (workspace_path TEXT PRIMARY KEY, enabled_json TEXT NOT NULL)");
  db.prepare("INSERT INTO project_mcp_settings (workspace_path, enabled_json) VALUES (?, ?)").run(
    path.resolve(workspacePath),
    JSON.stringify({ eco_agent_browser: browserEnabled, docs: true }),
  );
  db.close();
  return { dbPath, workspacePath };
}

test("project integrations migrate only the legacy browser flag until first save", async () => {
  const { dbPath, workspacePath } = await createDatabase();
  const store = new ProjectIntegrationsSettingsStore(new Database(dbPath) as never);
  store.initialize();
  expect(store.get(workspacePath)).toEqual({
    workspacePath: path.resolve(workspacePath),
    enabled: { browser: true },
  });

  store.save({
    workspacePath,
    enabled: { browser: false, imageGeneration: true, unknown: true } as Record<string, boolean>,
  });
  expect(store.get(workspacePath).enabled).toEqual({
    browser: false,
    imageGeneration: true,
  });
});

test("an explicit legacy browser opt-out survives migration", async () => {
  const { dbPath, workspacePath } = await createDatabase(false);
  const store = new ProjectIntegrationsSettingsStore(new Database(dbPath) as never);
  store.initialize();
  expect(store.get(workspacePath).enabled).toEqual({ browser: false });
});

test("corrupt legacy settings fail instead of silently disabling integrations", async () => {
  const { dbPath, workspacePath } = await createDatabase();
  const db = new Database(dbPath);
  db.prepare("UPDATE project_mcp_settings SET enabled_json = ? WHERE workspace_path = ?").run(
    "{broken",
    path.resolve(workspacePath),
  );
  db.close();
  const store = new ProjectIntegrationsSettingsStore(new Database(dbPath) as never);
  store.initialize();
  expect(() => store.get(workspacePath)).toThrow(/损坏/);
});
