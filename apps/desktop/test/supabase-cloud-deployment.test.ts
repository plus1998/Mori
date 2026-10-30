import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupabaseCloudDeployment } from "../src/main/supabase-cloud-deployment";
import {
  readSupabaseDeploymentBundle,
  type SupabaseDeploymentBundle,
} from "../src/main/supabase-deployment-bundle";
import { supabaseCloudProjectRef } from "../src/shared/supabase-deployment";

const ref = "abcdefghijklmnopqrst";
const token = "sbp_unit_test_token";
const core = "20260820100000";
const extension = "20260921190000";
const markerMigration = "20261005120000";
const backendMigration = "20261005130000";
const bundle: SupabaseDeploymentBundle = {
  version: { release: "1.0.0", apiVersion: 1, schema: backendMigration, hash: "a".repeat(64) },
  desktopVersion: "0.1.0-beta.12",
  migrations: [
    {
      version: core,
      name: "eco_center_core",
      sql: "create type public.eco_device_kind as enum ('desktop', 'mobile');",
    },
    { version: extension, name: "enforce_device_sessions_v2_only", sql: "select 'extension';" },
    {
      version: markerMigration,
      name: "eco_deployment_version",
      sql: "create table public.eco_deployment_version(id boolean);",
    },
    {
      version: backendMigration,
      name: "eco_backend_release",
      sql: "alter table public.eco_deployment_version rename column release to deployed_by_desktop_version;",
    },
  ],
  functions: [
    { name: "device-register", verifyJwt: true, entrypoint: "device-register/index.ts" },
    { name: "html-page-view", verifyJwt: false, entrypoint: "html-page-view/index.ts" },
  ],
  files: [
    { name: "device-register/index.ts", content: "import '../_shared/http.ts';" },
    { name: "html-page-view/index.ts", content: "Deno.serve(() => new Response('ok'));" },
    { name: "_shared/http.ts", content: "export {};" },
  ],
};

type RemoteFunction = {
  slug: string;
  version: number;
  status: string;
  verify_jwt: boolean;
  updated_at: number;
};
type Marker = {
  release?: string;
  backend_version?: string | null;
  api_version?: number | null;
  deployed_by_desktop_version?: string;
  schema_version: string;
  bundle_hash: string;
  migration_checksums: Record<string, string>;
  functions: Record<string, { version: number; updatedAt: number }>;
};

class Cloud {
  history = new Set<string>();
  core = false;
  markerTable = false;
  marker: Marker | null = null;
  functions: RemoteFunction[] = [];
  auth = {
    disable_signup: false,
    external_email_enabled: true,
    uri_allow_list: `https://${ref}.supabase.co/functions/v1/auth-email-confirmed,https://existing.example/confirm`,
  };
  realtime: { private_only: boolean | null } = { private_only: true };
  ignoreRealtimeUpdate = false;
  status = "ACTIVE_HEALTHY";
  failFunction: string | null = null;
  failMigration: string | null = null;
  failProbe = false;
  conflictingLease = false;
  lease: string | null = null;
  writes: string[] = [];
  uploads: FormData[] = [];
  snapshots: unknown[] = [];
  serverError = "deployment failed";
  keyReads = 0;

  seedCurrent() {
    this.history = new Set(bundle.migrations.map((entry) => entry.version));
    this.core = true;
    this.markerTable = true;
    this.functions = bundle.functions.map((fn) => ({
      slug: fn.name,
      version: 7,
      status: "ACTIVE",
      verify_jwt: fn.verifyJwt,
      updated_at: 70,
    }));
    this.marker = {
      backend_version: bundle.version.release,
      api_version: bundle.version.apiVersion,
      deployed_by_desktop_version: bundle.desktopVersion,
      schema_version: bundle.version.schema,
      bundle_hash: bundle.version.hash,
      migration_checksums: Object.fromEntries(
        bundle.migrations.map((entry) => [
          entry.version,
          createHash("sha256").update(entry.sql).digest("hex"),
        ]),
      ),
      functions: Object.fromEntries(
        this.functions.map((fn) => [fn.slug, { version: fn.version, updatedAt: fn.updated_at }]),
      ),
    };
  }

  service(desktopVersion = bundle.desktopVersion) {
    return new SupabaseCloudDeployment({
      loadBundle: async () => ({ ...structuredClone(bundle), desktopVersion }),
      fetch: this.fetch,
      onChange: (snapshot) => this.snapshots.push(snapshot),
    });
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.supabase.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe("error");
    const endpoint = url.pathname.replace(`/v1/projects/${ref}`, "");
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === "/v1/projects")
      return json([{ ref, name: "Test", region: "ap-east-1", status: this.status }]);
    if (endpoint === "/database/migrations") return json([...this.history].map((version) => ({ version })));
    if (endpoint === "/functions") return json(this.functions);
    if (endpoint === "/api-keys") {
      this.keyReads++;
      return json([
        { name: "service_role", api_key: "must-not-escape" },
        { name: "anon", api_key: "anon-public-key" },
      ]);
    }
    if (endpoint === "/config/auth" || endpoint === "/config/realtime") {
      if (init?.method === "PATCH") {
        const update = JSON.parse(String(init.body));
        if (endpoint === "/config/auth") Object.assign(this.auth, update);
        else if (!this.ignoreRealtimeUpdate) Object.assign(this.realtime, update);
        this.writes.push(endpoint);
      }
      return json(endpoint === "/config/auth" ? this.auth : this.realtime);
    }
    if (endpoint === "/functions/deploy") {
      const slug = url.searchParams.get("slug")!;
      this.writes.push(`function:${slug}`);
      this.uploads.push(init!.body as FormData);
      if (slug === this.failFunction) return json({ message: this.serverError }, 500);
      const metadata = JSON.parse(String((init!.body as FormData).get("metadata")));
      const existing = this.functions.find((fn) => fn.slug === slug);
      const fn = {
        slug,
        version: (existing?.version ?? 0) + 1,
        status: "ACTIVE",
        verify_jwt: metadata.verify_jwt,
        updated_at: (existing?.updated_at ?? 0) + 10,
      };
      this.functions = [...this.functions.filter((entry) => entry.slug !== slug), fn];
      return json(fn, 201);
    }
    if (endpoint === "/database/query") {
      const { query, read_only: readOnly } = JSON.parse(String(init?.body));
      if (query.includes("to_regclass")) {
        expect(readOnly).toBe(true);
        if (this.failProbe) return json({ message: "permission denied" }, 403);
        return json([{ history: this.history.size > 0, marker: this.markerTable, core: this.core }]);
      }
      if (query.startsWith("select to_jsonb(v)"))
        return json(this.marker ? [{ deployment: this.marker }] : []);
      if (query.includes("create table if not exists supabase_migrations.eco_deployment_lock")) {
        const owner = /values \(true, '([^']+)'/.exec(query)![1]!;
        this.lease = this.conflictingLease ? "another-client" : owner;
        return json([{ owner: this.lease }]);
      }
      if (query.startsWith("update supabase_migrations.eco_deployment_lock"))
        return json(this.lease ? [{ owner: this.lease }] : []);
      if (query.startsWith("delete from supabase_migrations.eco_deployment_lock")) {
        this.lease = null;
        return json([]);
      }
      if (query.includes("insert into supabase_migrations.schema_migrations")) {
        const version = /values \('(\d{14})'/.exec(query)![1]!;
        expect(query.trim().startsWith("begin;")).toBe(true);
        expect(query.trim().endsWith("commit;")).toBe(true);
        this.writes.push(`migration:${version}`);
        if (version === this.failMigration) return json({ message: this.serverError }, 500);
        this.history.add(version);
        if (version === core) this.core = true;
        if (version === markerMigration) this.markerTable = true;
        if (version === backendMigration && this.marker?.release) {
          const { release, ...row } = this.marker;
          this.marker = {
            ...row,
            deployed_by_desktop_version: release,
            backend_version: null,
            api_version: null,
          };
        }
        return json([]);
      }
      if (query.startsWith("insert into public.eco_deployment_version")) {
        this.writes.push("marker");
        const match =
          /values \(true, '([^']+)', (\d+),\s*'([^']+)', '(\d{14})',\s*'([a-f0-9]+)', '([^']+)'::jsonb,\s*'([^']+)'::jsonb/.exec(
            query,
          )!;
        this.marker = {
          backend_version: match[1]!,
          api_version: Number(match[2]),
          deployed_by_desktop_version: match[3]!,
          schema_version: match[4]!,
          bundle_hash: match[5]!,
          migration_checksums: JSON.parse(match[6]!),
          functions: JSON.parse(match[7]!),
        };
        return json([]);
      }
      throw new Error(`Unexpected SQL: ${query}`);
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }) as typeof fetch;
}

test("bundled deployment contains all migrations/functions and respects JWT config", async () => {
  const directory = fileURLToPath(new URL("../../../supabase", import.meta.url));
  const loaded = await readSupabaseDeploymentBundle(directory, "0.1.0-beta.12");
  expect(loaded.version.schema).toBe(backendMigration);
  expect(loaded.version.release).toBe("1.0.1");
  expect(loaded.version.apiVersion).toBe(1);
  expect(loaded.desktopVersion).toBe("0.1.0-beta.12");
  expect(loaded.functions).toHaveLength(11);
  expect(loaded.functions.find((fn) => fn.name === "html-page-view")?.verifyJwt).toBe(false);
  expect(loaded.functions.find((fn) => fn.name === "device-register")?.verifyJwt).toBe(true);
  expect(loaded.files.some((file) => file.name === "_shared/supabase.ts")).toBe(true);
  expect(loaded.migrations.some((entry) => entry.version === "20260822102000")).toBe(false);
  const nextDesktop = await readSupabaseDeploymentBundle(directory, "99.0.0");
  expect(nextDesktop.version).toEqual(loaded.version);
  expect(nextDesktop.desktopVersion).toBe("99.0.0");
});

test("backend manifest is required, validated, and included in the resource fingerprint", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eco-backend-bundle-"));
  const manifestFile = path.join(directory, "deployment.json");
  try {
    await expect(readSupabaseDeploymentBundle(directory, bundle.desktopVersion)).rejects.toThrow("ENOENT");
    await writeFile(manifestFile, JSON.stringify({ backendVersion: "desktop-beta", apiVersion: 1 }));
    await expect(readSupabaseDeploymentBundle(directory, bundle.desktopVersion)).rejects.toThrow();
    await writeFile(manifestFile, JSON.stringify({ backendVersion: "1.0.0" }));
    await expect(readSupabaseDeploymentBundle(directory, bundle.desktopVersion)).rejects.toThrow();
    await writeFile(manifestFile, JSON.stringify({ backendVersion: "1.0.0", apiVersion: 2 }));
    await expect(readSupabaseDeploymentBundle(directory, bundle.desktopVersion)).rejects.toThrow("不兼容");

    await mkdir(path.join(directory, "migrations"));
    for (const migration of bundle.migrations) {
      await writeFile(
        path.join(directory, "migrations", `${migration.version}_${migration.name}.sql`),
        migration.sql,
      );
    }
    await writeFile(
      path.join(directory, "config.toml"),
      bundle.functions.map((fn) => `[functions.${fn.name}]\nverify_jwt = ${fn.verifyJwt}\n`).join("\n"),
    );
    for (const file of bundle.files) {
      const filename = path.join(directory, "functions", file.name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, file.content);
    }
    await writeFile(manifestFile, JSON.stringify({ backendVersion: "1.0.0", apiVersion: 1 }));
    const first = await readSupabaseDeploymentBundle(directory, "0.1.0-beta.12");
    await writeFile(manifestFile, JSON.stringify({ backendVersion: "1.0.1", apiVersion: 1 }));
    const next = await readSupabaseDeploymentBundle(directory, "0.1.0-beta.12");
    expect(next.version.release).toBe("1.0.1");
    expect(next.version.hash).not.toBe(first.version.hash);
    await writeFile(
      path.join(directory, "functions/html-page-view/index.ts"),
      "Deno.serve(() => new Response('updated'));",
    );
    expect((await readSupabaseDeploymentBundle(directory, "0.1.0-beta.12")).version.hash).not.toBe(
      next.version.hash,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh project deploys, verifies, records version last, and connects using anon only", async () => {
  const cloud = new Cloud();
  cloud.realtime.private_only = false;
  const service = cloud.service();
  await service.authorize(token);
  expect((await service.inspect(ref)).report?.action).toBe("deploy");
  expect(cloud.writes).toEqual([]);
  const result = await service.deploy(ref);
  expect(result.job?.state).toBe("succeeded");
  expect(result.report?.action).toBe("current");
  expect(result.report?.canConnect).toBe(true);
  expect(cloud.marker?.backend_version).toBe("1.0.0");
  expect(cloud.marker?.api_version).toBe(1);
  expect(cloud.marker?.deployed_by_desktop_version).toBe(bundle.desktopVersion);
  expect(result.job?.completed).toBe(result.job?.total);
  expect(cloud.writes.at(-1)).toBe("marker");
  expect(cloud.lease).toBeNull();
  expect(cloud.auth.uri_allow_list).toContain("https://existing.example/confirm");
  expect(cloud.realtime.private_only).toBe(true);
  const metadata = JSON.parse(String(cloud.uploads[0]!.get("metadata")));
  expect(metadata).toEqual({
    name: "device-register",
    entrypoint_path: "device-register/index.ts",
    verify_jwt: true,
  });
  const files = cloud.uploads[0]!.getAll("file") as File[];
  expect(files.map((file) => file.name)).toEqual(["device-register/index.ts", "_shared/http.ts"]);
  expect(await service.getConnection(ref)).toEqual({
    supabaseUrl: `https://${ref}.supabase.co`,
    anonKey: "anon-public-key",
  });
  expect(JSON.stringify(service.getSnapshot())).not.toContain(token);
  expect(JSON.stringify(cloud.snapshots)).not.toContain("must-not-escape");
});

test("CLI legacy deployment is updated incrementally without repeating installed SQL", async () => {
  const cloud = new Cloud();
  cloud.core = true;
  cloud.history.add(core);
  const service = cloud.service();
  await service.authorize(token);
  const preview = (await service.inspect(ref)).report!;
  expect(preview.action).toBe("update");
  expect(preview.online).toBeNull();
  expect(preview.onlineSchema).toBe(core);
  expect((await service.deploy(ref)).report?.action).toBe("current");
  expect(cloud.writes).not.toContain(`migration:${core}`);
  expect(cloud.writes).toContain(`migration:${extension}`);
});

test("null Realtime config allows inspection and requires explicit configuration for deploy or update", async () => {
  for (const deployed of [false, true]) {
    const cloud = new Cloud();
    if (deployed) cloud.seedCurrent();
    cloud.realtime.private_only = null;
    const service = cloud.service();
    await service.authorize(token);
    const preview = (await service.inspect(ref)).report!;
    expect(preview.action).toBe(deployed ? "update" : "deploy");
    expect(preview.configurationReady).toBe(false);
    expect(cloud.writes).toEqual([]);
    const result = await service.deploy(ref);
    expect(result.job?.state).toBe("succeeded");
    expect(result.report?.action).toBe("current");
    expect(result.report?.configurationReady).toBe(true);
    expect(cloud.realtime.private_only).toBe(true);
    expect(cloud.writes).toContain("/config/realtime");
    expect(cloud.writes.at(-1)).toBe("marker");
    if (deployed) expect(cloud.writes.some((entry) => entry.startsWith("migration:"))).toBe(false);
  }
});

test("Realtime config still null after PATCH fails verification without recording a successful version", async () => {
  const cloud = new Cloud();
  cloud.realtime.private_only = null;
  cloud.ignoreRealtimeUpdate = true;
  const service = cloud.service();
  await service.authorize(token);
  const result = await service.deploy(ref);
  expect(result.job?.state).toBe("failed");
  expect(result.job?.phase).toBe("verifying");
  expect(result.job?.error).toContain("线上迁移或配置验证失败");
  expect(result.report).toBeNull();
  expect(cloud.writes).toContain("/config/realtime");
  expect(cloud.writes).not.toContain("marker");
  expect(cloud.marker).toBeNull();
  expect(cloud.lease).toBeNull();
});

test("latest deployment makes no writes, while a function changed online requires update", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  const service = cloud.service();
  await service.authorize(token);
  expect((await service.inspect(ref)).report?.action).toBe("current");
  expect((await service.deploy(ref)).job?.state).toBe("succeeded");
  expect(cloud.writes).toEqual([]);
  cloud.functions[0]!.version++;
  expect((await service.inspect(ref)).report?.action).toBe("update");
});

test("desktop source version never changes deployment or connection decisions", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  cloud.marker!.deployed_by_desktop_version = "99.0.0";
  for (const desktopVersion of ["0.1.0-beta.1", "100.0.0"]) {
    const service = cloud.service(desktopVersion);
    await service.authorize(token);
    const report = (await service.inspect(ref)).report!;
    expect(report.action).toBe("current");
    expect(report.local.release).toBe("1.0.0");
    expect(report.online?.release).toBe("1.0.0");
    expect(report.deployedByDesktopVersion).toBe("99.0.0");
    expect(report.canConnect).toBe(true);
    expect((await service.deploy(ref)).job?.state).toBe("succeeded");
    expect((await service.getConnection(ref)).anonKey).toBe("anon-public-key");
  }
  expect(cloud.writes).toEqual([]);
  expect(cloud.marker!.deployed_by_desktop_version).toBe("99.0.0");
});

test("newer backend with the same API can connect but cannot be overwritten", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  cloud.marker!.backend_version = "1.1.0";
  cloud.marker!.bundle_hash = "b".repeat(64);
  cloud.marker!.schema_version = "20261101000000";
  cloud.history.add(cloud.marker!.schema_version);
  const service = cloud.service();
  await service.authorize(token);
  const report = (await service.inspect(ref)).report!;
  expect(report.action).toBe("newer");
  expect(report.canConnect).toBe(true);
  expect((await service.getConnection(ref)).anonKey).toBe("anon-public-key");
  expect((await service.deploy(ref)).job?.state).toBe("failed");
  expect(cloud.writes).toEqual([]);
  // Connection rechecks actual state rather than trusting the earlier compatible preview.
  cloud.functions[0]!.version++;
  await expect(service.getConnection(ref)).rejects.toThrow("状态未通过验证");
  expect(cloud.keyReads).toBe(1);
});

test("an incompatible online API blocks connection even when its backend SemVer is lower", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  cloud.marker!.backend_version = "0.9.0";
  cloud.marker!.api_version = 2;
  const service = cloud.service();
  await service.authorize(token);
  const report = (await service.inspect(ref)).report!;
  expect(report.action).toBe("newer");
  expect(report.canConnect).toBe(false);
  await expect(service.getConnection(ref)).rejects.toThrow("接口版本 2");
  expect((await service.deploy(ref)).job?.state).toBe("failed");
  expect(cloud.keyReads).toBe(0);
  expect(cloud.writes).toEqual([]);
});

test("legacy desktop release remains audit data until the backend update is fully verified", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  const { backend_version, api_version, deployed_by_desktop_version, ...row } = cloud.marker!;
  cloud.marker = { ...row, release: "99.0.0", schema_version: markerMigration };
  cloud.history.delete(backendMigration);
  const service = cloud.service();
  await service.authorize(token);
  const legacy = (await service.inspect(ref)).report!;
  expect(legacy.action).toBe("update");
  expect(legacy.online).toBeNull();
  expect(legacy.canConnect).toBe(false);
  expect(legacy.deployedByDesktopVersion).toBe("99.0.0");
  expect(legacy.pendingMigrations).toEqual([backendMigration]);
  cloud.failFunction = "html-page-view";
  expect((await service.deploy(ref)).job?.state).toBe("failed");
  expect(cloud.marker!.backend_version).toBeNull();
  expect(cloud.marker!.deployed_by_desktop_version).toBe("99.0.0");
  const migrated = (await service.inspect(ref)).report!;
  expect(migrated.action).toBe("update");
  expect(migrated.online).toBeNull();
  expect(migrated.pendingMigrations).toEqual([]);
  cloud.failFunction = null;
  cloud.writes = [];
  const updated = await service.deploy(ref);
  expect(updated.job?.state).toBe("succeeded");
  expect(updated.report?.online?.release).toBe("1.0.0");
  expect(updated.report?.deployedByDesktopVersion).toBe(bundle.desktopVersion);
  expect(cloud.writes.some((entry) => entry.startsWith("migration:"))).toBe(false);
});

test("partial backend metadata and missing recorded migration history are explicit errors", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  const service = cloud.service();
  await service.authorize(token);
  cloud.marker!.api_version = null;
  await expect(service.inspect(ref)).rejects.toThrow();
  expect(service.getSnapshot().report).toBeNull();
  cloud.marker!.api_version = 1;
  cloud.marker!.schema_version = "20261101000000";
  await expect(service.inspect(ref)).rejects.toThrow("不在迁移历史中");
  expect(cloud.writes).toEqual([]);
});

test("newer CLI migration history without a release record still blocks an older deployment bundle", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  cloud.marker = null;
  cloud.history.add("20261101000000");
  const service = cloud.service();
  await service.authorize(token);
  const report = (await service.inspect(ref)).report!;
  expect(report.action).toBe("newer");
  expect(report.online).toBeNull();
  expect(report.onlineSchema).toBe("20261101000000");
  expect(report.canConnect).toBe(false);
  expect((await service.deploy(ref)).job?.state).toBe("failed");
  expect(cloud.writes).toEqual([]);
});

test("newer backend release, API, or schema prevents an older bundle from writing", async () => {
  for (const markerUpdate of [
    { backend_version: "1.1.0" },
    { api_version: 2 },
    { schema_version: "20261101000000" },
  ]) {
    const cloud = new Cloud();
    cloud.seedCurrent();
    Object.assign(cloud.marker!, markerUpdate);
    cloud.history.add(cloud.marker!.schema_version);
    const service = cloud.service("99.0.0");
    await service.authorize(token);
    expect((await service.inspect(ref)).report?.action).toBe("newer");
    expect((await service.deploy(ref)).job?.state).toBe("failed");
    expect(cloud.writes).toEqual([]);
  }
});

test("a failed function never records success and retry skips committed migrations", async () => {
  const cloud = new Cloud();
  cloud.failFunction = "html-page-view";
  const service = cloud.service();
  await service.authorize(token);
  const failed = await service.deploy(ref);
  expect(failed.job?.state).toBe("failed");
  expect(failed.job?.phase).toBe("functions");
  expect(failed.job?.item).toBe("html-page-view");
  expect(failed.report).toBeNull();
  expect(cloud.marker).toBeNull();
  expect(cloud.lease).toBeNull();
  cloud.failFunction = null;
  cloud.writes = [];
  expect((await service.deploy(ref)).job?.state).toBe("succeeded");
  expect(cloud.writes.some((entry) => entry.startsWith("migration:"))).toBe(false);
});

test("failed migration leaves its history unapplied and stops before deploying functions", async () => {
  const cloud = new Cloud();
  cloud.failMigration = extension;
  const service = cloud.service();
  await service.authorize(token);
  const failed = await service.deploy(ref);
  expect(failed.job?.phase).toBe("migrations");
  expect(cloud.history.has(core)).toBe(true);
  expect(cloud.history.has(extension)).toBe(false);
  expect(cloud.uploads).toHaveLength(0);
  expect(cloud.marker).toBeNull();
});

test("failed reads and inconsistent migration history are errors, not first deployment", async () => {
  const cloud = new Cloud();
  const service = cloud.service();
  await service.authorize(token);
  cloud.failProbe = true;
  await expect(service.inspect(ref)).rejects.toThrow("HTTP 403");
  expect(service.getSnapshot().report).toBeNull();
  cloud.failProbe = false;
  cloud.core = true;
  await expect(service.inspect(ref)).rejects.toThrow("不一致");
  cloud.history = new Set([core, markerMigration]);
  await expect(service.inspect(ref)).rejects.toThrow("缺口");
  expect(cloud.writes).toEqual([]);
});

test("remote deployment lease rejects a competing client before migration writes", async () => {
  const cloud = new Cloud();
  cloud.conflictingLease = true;
  const service = cloud.service();
  await service.authorize(token);
  const result = await service.deploy(ref);
  expect(result.job?.error).toContain("另一个 Mori 客户端");
  expect(cloud.writes).toEqual([]);
  expect(cloud.lease).toBe("another-client");
});

test("credentials are redacted from errors and authorization can be cleared", async () => {
  const cloud = new Cloud();
  cloud.failFunction = "device-register";
  cloud.serverError = `bad request ${token}`;
  const service = cloud.service();
  await service.authorize(token);
  const result = await service.deploy(ref);
  expect(result.job?.error).toContain("[已隐藏令牌]");
  expect(JSON.stringify(cloud.snapshots)).not.toContain(token);
  expect(service.forgetAuthorization().authorized).toBe(false);
  await expect(service.inspect(ref)).rejects.toThrow("请先授权");
});

test("only authorized healthy Cloud projects are eligible", async () => {
  const cloud = new Cloud();
  cloud.status = "INACTIVE";
  const service = cloud.service();
  await service.authorize(token);
  await expect(service.deploy(ref)).rejects.toThrow("恢复项目");
  await expect(service.inspect("zyxwvutsrqponmlkjihg")).rejects.toThrow("访问权限");
  expect(supabaseCloudProjectRef(`https://${ref}.supabase.co`)).toBe(ref);
  expect(supabaseCloudProjectRef("http://localhost:8000")).toBeNull();
  expect(supabaseCloudProjectRef(`https://${ref}.supabase.co.evil.example`)).toBeNull();
});

test("changed published migration SQL cannot be marked as a successful update", async () => {
  const cloud = new Cloud();
  cloud.seedCurrent();
  cloud.marker!.migration_checksums[core] = "b".repeat(64);
  const service = cloud.service();
  await service.authorize(token);
  await expect(service.inspect(ref)).rejects.toThrow("内容发生变化");
  const result = await service.deploy(ref);
  expect(result.job?.state).toBe("failed");
  expect(cloud.writes).toEqual([]);
});
