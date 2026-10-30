import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SUPABASE_BACKEND_VERSION_PATTERN,
  SUPPORTED_SUPABASE_API_VERSION,
  type SupabaseDeploymentConnection,
  type SupabaseDeploymentJob,
  type SupabaseDeploymentReport,
  type SupabaseDeploymentSnapshot,
} from "../shared/supabase-deployment";
import type { SupabaseDeploymentBundle } from "./supabase-deployment-bundle";

const projectRefSchema = z.string().regex(/^[a-z]{20}$/);
const projectsSchema = z.array(
  z.object({
    ref: projectRefSchema,
    name: z.string(),
    region: z.string(),
    status: z.string(),
  }),
);
const migrationsSchema = z.array(z.object({ version: z.string(), name: z.string().optional() }));
const functionSchema = z.object({
  slug: z.string(),
  version: z.number().int(),
  status: z.string(),
  updated_at: z.number().optional(),
  verify_jwt: z.boolean().optional(),
});
const functionsSchema = z.array(functionSchema);
const recordedFunctionsSchema = z.record(
  z.string(),
  z.object({
    version: z.number().int(),
    updatedAt: z.number().nullable(),
  }),
);
const markerBaseSchema = z.object({
  schema_version: z.string().regex(/^\d{14}$/),
  bundle_hash: z.string().regex(/^[a-f0-9]{64}$/),
  migration_checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  functions: recordedFunctionsSchema,
});
const backendMarkerSchema = markerBaseSchema.extend({
  backend_version: z.string().regex(SUPABASE_BACKEND_VERSION_PATTERN),
  api_version: z.number().int().positive(),
  deployed_by_desktop_version: z.string().min(1),
  release: z.never().optional(),
});
const migratedLegacyMarkerSchema = markerBaseSchema.extend({
  backend_version: z.null(),
  api_version: z.null(),
  deployed_by_desktop_version: z.string().min(1),
  release: z.never().optional(),
});
// Recognize the exact old format without interpreting its desktop release as a backend release.
// A partially written new record must fail validation rather than become a legacy installation.
const legacyMarkerSchema = markerBaseSchema
  .extend({
    release: z.string().min(1),
    backend_version: z.never().optional(),
    api_version: z.never().optional(),
    deployed_by_desktop_version: z.never().optional(),
  })
  .transform(({ release, ...row }) => ({
    ...row,
    backend_version: null,
    api_version: null,
    deployed_by_desktop_version: release,
  }));
const markerSchema = z
  .array(
    z.object({ deployment: z.union([backendMarkerSchema, migratedLegacyMarkerSchema, legacyMarkerSchema]) }),
  )
  .max(1);
const probeSchema = z
  .array(
    z.object({
      history: z.boolean(),
      marker: z.boolean(),
      core: z.boolean(),
    }),
  )
  .length(1);
const authConfigSchema = z.object({
  disable_signup: z.boolean().nullable(),
  external_email_enabled: z.boolean().nullable(),
  uri_allow_list: z.string().nullable(),
});
const realtimeConfigSchema = z.object({ private_only: z.boolean().nullable() });

const PROBE_SQL = `select
  to_regclass('supabase_migrations.schema_migrations') is not null as history,
  to_regclass('public.eco_deployment_version') is not null as marker,
  to_regtype('public.eco_device_kind') is not null as core`;
const MARKER_SQL = "select to_jsonb(v) as deployment from public.eco_deployment_version v where id = true";
const API_ORIGIN = "https://api.supabase.com/v1";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function migrationChecksums(bundle: SupabaseDeploymentBundle): Record<string, string> {
  return Object.fromEntries(
    bundle.migrations.map((migration) => [
      migration.version,
      createHash("sha256").update(migration.sql).digest("hex"),
    ]),
  );
}

/** SemVer ordering for releases, including beta.N; rejects unknown formats. */
function compareReleases(left: string, right: string): number {
  const parse = (value: string) => {
    const match = SUPABASE_BACKEND_VERSION_PATTERN.exec(value);
    if (!match) throw new Error(`无法识别后端发布版本：${value}`);
    return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") };
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! > b.numbers[i]! ? 1 : -1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export class SupabaseCloudDeployment {
  private token = "";
  private snapshot: SupabaseDeploymentSnapshot = { authorized: false, projects: [], report: null, job: null };
  private busy = false;

  constructor(
    private readonly options: {
      loadBundle: () => Promise<SupabaseDeploymentBundle>;
      fetch?: typeof fetch;
      onChange?: (snapshot: SupabaseDeploymentSnapshot) => void;
    },
  ) {}

  getSnapshot(): SupabaseDeploymentSnapshot {
    return structuredClone(this.snapshot);
  }

  private emit(): SupabaseDeploymentSnapshot {
    const snapshot = this.getSnapshot();
    this.options.onChange?.(snapshot);
    return snapshot;
  }

  private assertIdle(): void {
    if (this.busy) throw new Error("Supabase 操作正在进行，请等待完成。");
  }

  async authorize(accessToken: unknown): Promise<SupabaseDeploymentSnapshot> {
    this.assertIdle();
    const token = z.string().trim().min(1).parse(accessToken);
    if (/\s/.test(token)) throw new Error("Access Token 格式无效。");
    this.busy = true;
    this.token = token;
    this.snapshot = { authorized: false, projects: [], report: null, job: null };
    try {
      const projects = projectsSchema.parse(await this.request("/projects"));
      // Load packaged resources before enabling deployment; missing resources are an error.
      await this.options.loadBundle();
      this.snapshot = { authorized: true, projects, report: null, job: null };
      return this.emit();
    } catch (error) {
      this.token = "";
      this.emit();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  forgetAuthorization(): SupabaseDeploymentSnapshot {
    this.assertIdle();
    this.token = "";
    this.snapshot = { authorized: false, projects: [], report: null, job: null };
    return this.emit();
  }

  private requireProject(ref: unknown): string {
    const projectRef = projectRefSchema.parse(ref);
    if (!this.token || !this.snapshot.authorized) throw new Error("请先授权 Supabase Cloud。");
    const project = this.snapshot.projects.find((entry) => entry.ref === projectRef);
    if (!project) throw new Error("当前授权没有此 Cloud 项目的访问权限。");
    if (project.status !== "ACTIVE_HEALTHY") {
      throw new Error(`项目当前状态为 ${project.status}，请先在 Supabase Dashboard 恢复项目。`);
    }
    return projectRef;
  }

  async inspect(ref: unknown): Promise<SupabaseDeploymentSnapshot> {
    this.assertIdle();
    const projectRef = this.requireProject(ref);
    this.busy = true;
    this.snapshot.report = null;
    this.emit();
    try {
      const bundle = await this.options.loadBundle();
      this.snapshot.report = await this.inspectRemote(projectRef, bundle);
      return this.emit();
    } finally {
      this.busy = false;
    }
  }

  private async inspectRemote(
    ref: string,
    bundle: SupabaseDeploymentBundle,
  ): Promise<SupabaseDeploymentReport> {
    const base = `/projects/${ref}`;
    const [probeData, functionData, authData, realtimeData] = await Promise.all([
      this.query(ref, PROBE_SQL, true),
      this.request(`${base}/functions`),
      this.request(`${base}/config/auth`),
      this.request(`${base}/config/realtime`),
    ]);
    const probe = probeSchema.parse(probeData)[0]!;
    const functions = functionsSchema.parse(functionData);
    const auth = authConfigSchema.parse(authData);
    const realtime = realtimeConfigSchema.parse(realtimeData);
    const history = probe.history
      ? migrationsSchema.parse(await this.request(`${base}/database/migrations`))
      : [];
    const marker = probe.marker
      ? markerSchema.parse(await this.query(ref, MARKER_SQL, true))[0]?.deployment
      : undefined;
    const applied = new Set(history.map((entry) => entry.version));
    const coreVersion = bundle.migrations[0]!.version;
    if (probe.core !== applied.has(coreVersion)) {
      throw new Error("线上 Mori 数据结构与迁移历史不一致，无法安全部署。请先修复迁移历史。");
    }
    const installed = bundle.migrations.filter((entry) => applied.has(entry.version));
    const pending = bundle.migrations.filter((entry) => !applied.has(entry.version));
    if (pending.some((entry) => installed.some((done) => done.version > entry.version))) {
      throw new Error("线上 Mori 迁移历史存在缺口，无法安全更新。请先修复迁移历史。");
    }
    if (marker && !probe.core) throw new Error("线上部署记录存在，但 Mori 数据结构缺失。");
    if (marker) {
      if (!applied.has(marker.schema_version)) {
        throw new Error("线上部署记录的数据库版本不在迁移历史中，请先修复部署记录或迁移历史。");
      }
      const checksums = migrationChecksums(bundle);
      for (const migration of installed) {
        if (migration.version > marker.schema_version) continue;
        if (marker.migration_checksums[migration.version] !== checksums[migration.version]) {
          throw new Error(`已发布的迁移 ${migration.version} 内容发生变化，请恢复旧迁移并追加新迁移。`);
        }
      }
    }
    const online =
      marker?.backend_version != null
        ? {
            release: marker.backend_version,
            apiVersion: marker.api_version,
            schema: marker.schema_version,
            hash: marker.bundle_hash,
          }
        : null;
    const onlineSchema =
      history
        .map((entry) => entry.version)
        .sort()
        .at(-1) ?? null;
    const configurationReady =
      auth.disable_signup === false &&
      auth.external_email_enabled === true &&
      (auth.uri_allow_list ?? "")
        .split(",")
        .map((url) => url.trim())
        .includes(this.confirmationUrl(ref)) &&
      realtime.private_only === true;
    const functionsMatch = bundle.functions.every((fn) => {
      const live = functions.find((entry) => entry.slug === fn.name);
      const recorded = marker?.functions[fn.name];
      return (
        live?.status === "ACTIVE" &&
        live.verify_jwt === fn.verifyJwt &&
        recorded &&
        recorded.version === live.version &&
        recorded.updatedAt === (live.updated_at ?? null)
      );
    });
    let action: SupabaseDeploymentReport["action"];
    if (
      (onlineSchema !== null && onlineSchema > bundle.version.schema) ||
      (online &&
        (online.apiVersion > SUPPORTED_SUPABASE_API_VERSION ||
          compareReleases(online.release, bundle.version.release) > 0))
    ) {
      action = "newer";
    } else if (
      online?.hash === bundle.version.hash &&
      online.release === bundle.version.release &&
      online.apiVersion === bundle.version.apiVersion &&
      !pending.length &&
      functionsMatch &&
      configurationReady
    ) {
      action = "current";
    } else {
      action =
        probe.core ||
        installed.length ||
        bundle.functions.some((fn) => functions.some((entry) => entry.slug === fn.name))
          ? "update"
          : "deploy";
    }
    return {
      projectRef: ref,
      action,
      local: bundle.version,
      online,
      onlineSchema,
      deployedByDesktopVersion: marker?.deployed_by_desktop_version ?? null,
      canConnect: Boolean(
        online &&
          online.apiVersion === SUPPORTED_SUPABASE_API_VERSION &&
          (action === "current" || action === "newer") &&
          !pending.length &&
          functionsMatch &&
          configurationReady,
      ),
      pendingMigrations: pending.map((entry) => entry.version),
      configurationReady,
      functions: bundle.functions.map((fn) => {
        const live = functions.find((entry) => entry.slug === fn.name);
        return { name: fn.name, version: live?.version ?? null, status: live?.status ?? null };
      }),
    };
  }

  async deploy(ref: unknown): Promise<SupabaseDeploymentSnapshot> {
    this.assertIdle();
    const projectRef = this.requireProject(ref);
    this.busy = true;
    const owner = randomUUID();
    let leased = false;
    this.snapshot.report = null;
    this.snapshot.job = {
      projectRef,
      state: "running",
      phase: "checking",
      item: null,
      completed: 0,
      total: 0,
      error: null,
    };
    this.emit();
    try {
      const bundle = await this.options.loadBundle();
      // Always re-read immediately before a write. Renderer reports are only previews.
      let report = await this.inspectRemote(projectRef, bundle);
      this.snapshot.report = report;
      if (report.action === "newer")
        throw new Error("线上后端、数据库或接口版本较新，当前部署包不能覆盖。请升级 Mori 获取新部署包。");
      if (report.action !== "current") {
        await this.acquireLease(projectRef, owner);
        leased = true;
        report = await this.inspectRemote(projectRef, bundle);
        this.snapshot.report = report;
        if (report.action === "newer")
          throw new Error("线上后端、数据库或接口版本较新，当前部署包不能覆盖。请升级 Mori 获取新部署包。");
        if (report.action !== "current") {
          const pending = bundle.migrations.filter((entry) =>
            report.pendingMigrations.includes(entry.version),
          );
          this.progress({ total: pending.length + bundle.functions.length + 3 });
          for (const migration of pending) {
            this.progress({ phase: "migrations", item: `${migration.version}_${migration.name}.sql` });
            await this.renewLease(projectRef, owner);
            // SQL + CLI-compatible history commit together, or both roll back.
            await this.query(
              projectRef,
              `begin;
              create table if not exists supabase_migrations.schema_migrations (
                version text primary key, statements text[], name text
              );
              alter table supabase_migrations.schema_migrations add column if not exists statements text[];
              alter table supabase_migrations.schema_migrations add column if not exists name text;
              ${migration.sql}
              insert into supabase_migrations.schema_migrations(version, name, statements)
              values (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, array[${sqlLiteral(migration.sql)}]);
              commit;`,
            );
            this.advance();
          }
          const recorded: z.infer<typeof recordedFunctionsSchema> = {};
          for (const fn of bundle.functions) {
            this.progress({ phase: "functions", item: fn.name });
            await this.renewLease(projectRef, owner);
            const body = new FormData();
            body.append(
              "metadata",
              JSON.stringify({ name: fn.name, entrypoint_path: fn.entrypoint, verify_jwt: fn.verifyJwt }),
            );
            for (const file of bundle.files.filter(
              (file) => file.name.startsWith(`${fn.name}/`) || file.name.startsWith("_shared/"),
            )) {
              body.append("file", new Blob([file.content], { type: "text/plain" }), file.name);
            }
            const result = functionSchema.parse(
              await this.request(`/projects/${projectRef}/functions/deploy?slug=${fn.name}`, {
                method: "POST",
                body,
              }),
            );
            if (result.slug !== fn.name || result.status !== "ACTIVE")
              throw new Error(`函数 ${fn.name} 未成功激活。`);
            recorded[fn.name] = { version: result.version, updatedAt: result.updated_at ?? null };
            this.advance();
          }
          this.progress({ phase: "config", item: null });
          await this.renewLease(projectRef, owner);
          await this.configureProject(projectRef);
          this.advance();
          this.progress({ phase: "verifying", item: null });
          await this.renewLease(projectRef, owner);
          const live = functionsSchema.parse(await this.request(`/projects/${projectRef}/functions`));
          for (const fn of bundle.functions) {
            const actual = live.find((entry) => entry.slug === fn.name);
            if (
              !actual ||
              actual.status !== "ACTIVE" ||
              actual.verify_jwt !== fn.verifyJwt ||
              actual.version !== recorded[fn.name]!.version
            )
              throw new Error(`函数 ${fn.name} 线上版本验证失败。`);
            recorded[fn.name]!.updatedAt = actual.updated_at ?? null;
          }
          const verified = await this.inspectRemote(projectRef, bundle);
          if (verified.pendingMigrations.length || !verified.configurationReady)
            throw new Error("线上迁移或配置验证失败。");
          this.advance();
          this.progress({ phase: "recording", item: null });
          await this.renewLease(projectRef, owner);
          await this.query(
            projectRef,
            `insert into public.eco_deployment_version
            (id, backend_version, api_version, deployed_by_desktop_version, schema_version,
              bundle_hash, migration_checksums, functions, deployed_at)
            values (true, ${sqlLiteral(bundle.version.release)}, ${bundle.version.apiVersion},
              ${sqlLiteral(bundle.desktopVersion)}, ${sqlLiteral(bundle.version.schema)},
              ${sqlLiteral(bundle.version.hash)}, ${sqlLiteral(JSON.stringify(migrationChecksums(bundle)))}::jsonb,
              ${sqlLiteral(JSON.stringify(recorded))}::jsonb, now())
            on conflict (id) do update set backend_version = excluded.backend_version,
              api_version = excluded.api_version, deployed_by_desktop_version = excluded.deployed_by_desktop_version,
              schema_version = excluded.schema_version,
              bundle_hash = excluded.bundle_hash, migration_checksums = excluded.migration_checksums,
              functions = excluded.functions, deployed_at = excluded.deployed_at;`,
          );
          this.advance();
        }
      }
      this.progress({ phase: "verifying", item: null });
      this.snapshot.report = await this.inspectRemote(projectRef, bundle);
      if (this.snapshot.report.action !== "current")
        throw new Error("部署后的线上版本与本地资源不一致，请重新检查。");
    } catch (error) {
      this.snapshot.report = null;
      this.progress({ state: "failed", error: this.safeError(error) });
    } finally {
      if (leased) {
        try {
          await this.query(
            projectRef,
            `delete from supabase_migrations.eco_deployment_lock where id = true and owner = ${sqlLiteral(owner)}`,
          );
        } catch (error) {
          this.progress({
            state: "failed",
            error: `${this.snapshot.job!.error ?? "部署完成，但释放部署锁失败"}；${this.safeError(error)}`,
          });
        }
      }
      this.busy = false;
    }
    if (this.snapshot.job!.state === "running") this.progress({ state: "succeeded" });
    return this.emit();
  }

  private progress(update: Partial<SupabaseDeploymentJob>): void {
    Object.assign(this.snapshot.job!, update);
    this.emit();
  }

  private advance(): void {
    this.progress({ completed: this.snapshot.job!.completed + 1 });
  }

  private async acquireLease(ref: string, owner: string): Promise<void> {
    const result = await this.query(
      ref,
      `begin;
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.eco_deployment_lock (
        id boolean primary key check(id), owner text not null, expires_at timestamptz not null
      );
      revoke all on supabase_migrations.eco_deployment_lock from anon, authenticated;
      insert into supabase_migrations.eco_deployment_lock values (true, ${sqlLiteral(owner)}, now() + interval '10 minutes')
      on conflict(id) do update set owner = excluded.owner, expires_at = excluded.expires_at
      where eco_deployment_lock.expires_at < now();
      commit;
      select owner from supabase_migrations.eco_deployment_lock where id = true;`,
    );
    const rows = z
      .array(z.object({ owner: z.string() }))
      .length(1)
      .parse(result);
    if (rows[0]!.owner !== owner) throw new Error("另一个 Mori 客户端正在部署此项目，请等待完成后重试。");
  }

  private async renewLease(ref: string, owner: string): Promise<void> {
    const rows = z.array(z.object({ owner: z.string() })).parse(
      await this.query(
        ref,
        `update supabase_migrations.eco_deployment_lock set expires_at = now() + interval '10 minutes'
      where id = true and owner = ${sqlLiteral(owner)} and expires_at > now() returning owner`,
      ),
    );
    if (rows.length !== 1 || rows[0]!.owner !== owner)
      throw new Error("部署锁已失效，已停止后续操作。请重新检查线上版本。");
  }

  private confirmationUrl(ref: string): string {
    return `https://${ref}.supabase.co/functions/v1/auth-email-confirmed`;
  }

  private async configureProject(ref: string): Promise<void> {
    const base = `/projects/${ref}`;
    const auth = authConfigSchema.parse(await this.request(`${base}/config/auth`));
    const redirects = new Set(
      (auth.uri_allow_list ?? "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
    );
    redirects.add(this.confirmationUrl(ref));
    await this.request(`${base}/config/auth`, {
      method: "PATCH",
      body: JSON.stringify({
        disable_signup: false,
        external_email_enabled: true,
        uri_allow_list: [...redirects].join(","),
      }),
    });
    await this.request(`${base}/config/realtime`, {
      method: "PATCH",
      body: JSON.stringify({ private_only: true }),
    });
  }

  async getConnection(ref: unknown): Promise<SupabaseDeploymentConnection> {
    this.assertIdle();
    const projectRef = this.requireProject(ref);
    this.busy = true;
    try {
      const bundle = await this.options.loadBundle();
      const report = await this.inspectRemote(projectRef, bundle);
      this.snapshot.report = report;
      this.emit();
      if (!report.canConnect) {
        if (report.online && report.online.apiVersion !== SUPPORTED_SUPABASE_API_VERSION) {
          throw new Error(
            `线上后端接口版本 ${report.online.apiVersion} 与当前客户端支持的版本 ${SUPPORTED_SUPABASE_API_VERSION} 不兼容，请使用兼容的客户端。`,
          );
        }
        throw new Error(
          report.action === "newer"
            ? "线上后端状态未通过验证，当前部署包较旧。请使用匹配的部署包修复后再连接。"
            : "请先完成此项目的部署或更新，并验证线上后端状态。",
        );
      }
      const keys = z
        .array(z.object({ name: z.string(), api_key: z.string().nullable().optional() }))
        .parse(await this.request(`/projects/${projectRef}/api-keys?reveal=true`));
      const anonKey = keys.find((entry) => entry.name === "anon")?.api_key;
      if (!anonKey) throw new Error("此项目未提供 anon key，请在 Supabase Dashboard 检查 API Keys。");
      return { supabaseUrl: `https://${projectRef}.supabase.co`, anonKey };
    } finally {
      this.busy = false;
    }
  }

  private query(ref: string, query: string, readOnly = false): Promise<unknown> {
    return this.request(`/projects/${ref}/database/query`, {
      method: "POST",
      body: JSON.stringify({ query, read_only: readOnly }),
    });
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.token ? message.replaceAll(this.token, "[已隐藏令牌]") : message;
  }

  private async request(endpoint: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${API_ORIGIN}${endpoint}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(120_000),
        redirect: "error",
      });
    } catch (error) {
      throw new Error(`Supabase Cloud 请求失败（${endpoint}）：${this.safeError(error)}`);
    }
    const content = await response.text();
    if (!response.ok) {
      const hint =
        response.status === 401
          ? "Access Token 无效或已过期。"
          : response.status === 403
            ? "当前令牌或账号缺少此操作的权限。"
            : response.status === 429
              ? "请求频率受限，请稍后重试。"
              : "";
      throw new Error(
        `Supabase Cloud HTTP ${response.status}（${endpoint}）：${hint} ${this.safeError(content).slice(0, 800)}`,
      );
    }
    if (!content.trim()) return null;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`Supabase Cloud 返回了无法解析的数据（${endpoint}）。`);
    }
  }
}
