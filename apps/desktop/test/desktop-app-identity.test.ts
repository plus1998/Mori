import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");
const devScriptSource = readFileSync(fileURLToPath(new URL("../scripts/dev.mjs", import.meta.url)), "utf8");

function identityRun(packaged: boolean, suffix = "") {
  // An isolated mock keeps Electron's process-only module out of other tests.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `
      import { mock } from "bun:test";
      const paths = {};
      let name = "@eco/desktop";
      let aboutPanelOptions;
      const defaults = {
        userData: "/legacy/@eco/desktop",
        sessionData: "/legacy/@eco/desktop",
        logs: "/legacy/logs/@eco/desktop",
      };
      const application = {
        isPackaged: ${packaged},
        getPath(key) { return paths[key] ?? (name === "@eco/desktop" ? defaults[key] : "/unexpected/" + name); },
        setPath(key, value) { paths[key] = value; },
        setAppLogsPath(value) { paths.logs = value; },
        setName(value) { name = value; },
        setAboutPanelOptions(value) { aboutPanelOptions = value; },
      };
      mock.module(Bun.resolveSync("electron", ${JSON.stringify(fileURLToPath(new URL("../src/main", import.meta.url)))}), () => ({ app: application }));
      const { configureDesktopIdentity, applyDesktopDisplayName } = await import(${JSON.stringify(fileURLToPath(new URL("../src/main/desktop-app-identity.ts", import.meta.url)))});
      configureDesktopIdentity();
      const keychainName = name;
      applyDesktopDisplayName();
      console.log(JSON.stringify({ name, paths, keychainName, aboutPanelOptions }));
    `,
    ],
    env: { ...process.env, ECO_DEV_USER_DATA_SUFFIX: suffix },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("packaged rebrand keeps existing data, browser sessions and logs", () => {
  expect(identityRun(true)).toEqual({
    name: "Mori",
    aboutPanelOptions: { applicationName: "Mori" },
    keychainName: "@eco/desktop",
    paths: {
      userData: "/legacy/@eco/desktop",
      sessionData: "/legacy/@eco/desktop",
      logs: "/legacy/logs/@eco/desktop",
    },
  });
});

test("dev rebrand keeps suffix isolation and old storage paths", () => {
  for (const suffix of ["", "Preview"]) {
    const resolved = suffix || "Dev";
    expect(identityRun(false, suffix)).toEqual({
      name: "Mori Dev",
      aboutPanelOptions: { applicationName: "Mori Dev" },
      keychainName: "Eco Coding Dev",
      paths: {
        userData: `/legacy/@eco/desktop${resolved}`,
        sessionData: `/legacy/@eco/desktop${resolved}`,
        logs:
          process.platform === "darwin"
            ? `/legacy/logs/@eco/desktop${resolved}`
            : `/legacy/@eco/desktop${resolved}/logs`,
      },
    });
  }
});

test("main process configures dev identity before single-instance lock", () => {
  expect(indexSource).toContain(
    'import { applyDesktopDisplayName, configureDesktopIdentity } from "./desktop-app-identity"',
  );
  expect(indexSource).toMatch(/\.whenReady\(\)\s*\.then\(async \(\) => \{\s*applyDesktopDisplayName\(\);/);
  expect(indexSource).toMatch(
    /configureDesktopIdentity\(\);\s*\n\s*\/\/ The shared SQLite store and fixed-port gateway require a single main-process writer\.\s*\nconst e2eMode = process\.env\.ECO_E2E === "1";\s*\nconst hasSingleInstanceLock = e2eMode \? true : app\.requestSingleInstanceLock\(\);/,
  );
  expect(devScriptSource).toContain("ECO_DEV_USER_DATA_SUFFIX");
});
