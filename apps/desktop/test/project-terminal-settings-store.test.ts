import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectTerminalSettingsStore } from "../src/main/project-terminal-settings-store";
import { MAX_TERMINAL_STARTUP_COMMAND_LENGTH } from "../src/shared/project-terminal-settings";

test("startup commands persist per project across reopening and can be cleared", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "eco-project-terminal-"));
  const filename = path.join(directory, "settings.sqlite");
  let db = new DatabaseSync(filename);
  const projectA = path.join(directory, "a");
  const projectB = path.join(directory, "b");
  try {
    let store = new ProjectTerminalSettingsStore(db);
    store.initialize();
    expect(store.get(projectA).startupCommand).toBe("");
    store.save({ workspacePath: projectA, startupCommand: " nvm use 18\r\nexport APP_ENV=dev\r\n" });
    store.save({ workspacePath: projectB, startupCommand: "nvm use 22" });
    db.close();
    db = new DatabaseSync(filename);
    store = new ProjectTerminalSettingsStore(db);
    store.initialize();
    expect(store.get(path.join(projectA, "."))).toEqual({
      workspacePath: projectA,
      startupCommand: "nvm use 18\nexport APP_ENV=dev",
    });
    expect(store.get(projectB).startupCommand).toBe("nvm use 22");
    store.save({ workspacePath: projectA, startupCommand: " \n\t" });
    expect(store.get(projectA).startupCommand).toBe("");
    expect(store.get(projectB).startupCommand).toBe("nvm use 22");
    expect(() => store.save({ workspacePath: projectB, startupCommand: "bad\u0000command" })).toThrow();
    expect(() =>
      store.save({
        workspacePath: projectB,
        startupCommand: "x".repeat(MAX_TERMINAL_STARTUP_COMMAND_LENGTH + 1),
      }),
    ).toThrow();
    expect(store.get(projectB).startupCommand).toBe("nvm use 22");
    expect(() => store.get("  ")).toThrow(/path is required/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
