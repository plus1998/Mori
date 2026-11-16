import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { createElement } from "react";
import { readSupabaseSelfHostDeploymentContext } from "../src/main/supabase-self-host-context";
import { SshBookmarksPanel } from "../src/renderer/SshBookmarksPanel";
import { SupabaseSelfHostDeploymentPanel } from "../src/renderer/SupabaseSelfHostDeploymentPanel";
import { appendSupabaseSelfHostDraft } from "../src/renderer/supabase-self-host-draft";
import { composerReferences } from "../src/shared/composer-references";
import type { SshBookmarkView } from "../src/shared/ssh-bookmarks";
import { renderLocalized } from "./i18n-test";

const bookmark: SshBookmarkView = {
  id: "server-test",
  name: "生产环境 / SSH",
  host: "192.0.2.10",
  port: 2222,
  username: "ubuntu",
  authType: "key",
  keySource: "path",
  keyPath: "/private/ssh/secret-key",
  order: 0,
  hasPassword: false,
  hasStoredKey: false,
};
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("self-host draft preserves prior content and adds an atomic SSH reference without private fields", () => {
  const draft = appendSupabaseSelfHostDraft("已有草稿\n保留这一行", bookmark, "请部署 Mori Supabase。");
  expect(draft).toStartWith("已有草稿\n保留这一行\n\n");
  expect(draft).toEndWith("请部署 Mori Supabase。");
  expect(composerReferences(draft)).toEqual([
    { kind: "ssh", id: bookmark.id, label: bookmark.name, detail: "ubuntu@192.0.2.10:2222" },
  ]);
  expect(draft).not.toContain("/private/ssh/secret-key");
  expect(draft).not.toContain("hasPassword");
  expect(composerReferences(appendSupabaseSelfHostDraft("", bookmark, "deploy"))).toHaveLength(1);
});

test("deployment entry is available without Cloud authorization in both languages", () => {
  const element = createElement(SupabaseSelfHostDeploymentPanel, {
    onPrepare: async () => {},
    onBookmarksChange: () => {},
  });
  const zh = renderLocalized(element, "zh-CN");
  expect(zh).toContain("自托管部署");
  expect(zh).toContain("选择服务器");
  expect(zh).not.toContain("Personal Access Token");
  const en = renderLocalized(element, "en-US");
  expect(en).toContain("Self-hosted deployment");
  expect(en).toContain("Choose server");
});

test("bookmark selection works without a project and shows the selected server and add action", () => {
  const markup = renderLocalized(
    createElement(SshBookmarksPanel, {
      bookmarks: [bookmark],
      onBookmarksChange: () => {},
      selection: { selectedId: bookmark.id, onSelect: () => {}, description: "选择服务器或添加书签。" },
    }),
    "zh-CN",
  );
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain("ubuntu@192.0.2.10:2222");
  expect(markup).toContain("添加书签");
  expect(markup).toContain("选择服务器或添加书签。");
  expect(markup).not.toContain("请先打开项目后再连接 SSH");
  expect(markup).not.toContain("删除 生产环境");
});

test("packaged deployment kit contains the matching backend, runnable script and guide", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-selfhost-resources-"));
  temporary.push(root);
  const config = load(await readFile(path.join(repo, "apps/desktop/electron-builder.yml"), "utf8")) as {
    extraResources: { from: string; to: string }[];
  };
  for (const target of ["supabase", "scripts/supabase-self-host-apply.mjs", "docs/supabase-self-host.md"]) {
    const entry = config.extraResources.find((resource) => resource.to === target);
    expect(entry).toBeDefined();
    if (!entry) throw new Error(`Missing packaged deployment resource: ${target}`);
    await mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await cp(path.resolve(repo, "apps/desktop", entry.from), path.join(root, target), { recursive: true });
  }
  const context = await readSupabaseSelfHostDeploymentContext(root, "0.0.0-test");
  const manifest = JSON.parse(await readFile(path.join(root, "supabase/deployment.json"), "utf8")) as {
    backendVersion: string;
  };
  expect(context.backendVersion).toBe(manifest.backendVersion);
  expect(context.supabaseDirectory).toBe(path.join(root, "supabase"));
  expect(context.applyScriptPath).toBe(path.join(root, "scripts/supabase-self-host-apply.mjs"));
  expect(context.guidePath).toBe(path.join(root, "docs/supabase-self-host.md"));
  await rm(context.applyScriptPath);
  await expect(readSupabaseSelfHostDeploymentContext(root, "0.0.0-test")).rejects.toThrow(
    "supabase-self-host-apply.mjs",
  );
});
