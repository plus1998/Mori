export interface SupabaseCloudProject {
  ref: string;
  name: string;
  region: string;
  status: string;
}

/** Increment when the Eco backend API contract breaks compatibility. */
export const SUPPORTED_SUPABASE_API_VERSION = 1;

export const SUPABASE_BACKEND_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface SupabaseDeploymentVersion {
  /** Backend SemVer from supabase/deployment.json, independent of the desktop release. */
  release: string;
  apiVersion: number;
  schema: string;
  hash: string;
}

export interface SupabaseDeploymentReport {
  projectRef: string;
  action: "deploy" | "update" | "current" | "newer";
  local: SupabaseDeploymentVersion;
  online: SupabaseDeploymentVersion | null;
  /** CLI/legacy installations may have migration history but no backend release record. */
  onlineSchema: string | null;
  /** Audit only; never used to decide deployment or API compatibility. */
  deployedByDesktopVersion: string | null;
  canConnect: boolean;
  pendingMigrations: string[];
  configurationReady: boolean;
  functions: Array<{ name: string; version: number | null; status: string | null }>;
}

export interface SupabaseDeploymentJob {
  projectRef: string;
  state: "running" | "succeeded" | "failed";
  phase: "checking" | "migrations" | "functions" | "config" | "recording" | "verifying";
  item: string | null;
  completed: number;
  total: number;
  error: string | null;
}

export interface SupabaseDeploymentSnapshot {
  authorized: boolean;
  projects: SupabaseCloudProject[];
  report: SupabaseDeploymentReport | null;
  job: SupabaseDeploymentJob | null;
}

export interface SupabaseDeploymentConnection {
  supabaseUrl: string;
  anonKey: string;
}

export interface SupabaseSelfHostDeploymentContext {
  backendVersion: string;
  supabaseDirectory: string;
  applyScriptPath: string;
  guidePath: string;
}

export function supabaseCloudProjectRef(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = /^([a-z]{20})\.supabase\.co$/.exec(parsed.hostname);
    return parsed.protocol === "https:" && !parsed.port && match ? match[1]! : null;
  } catch {
    return null;
  }
}
