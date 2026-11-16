import { access } from "node:fs/promises";
import path from "node:path";
import type { SupabaseSelfHostDeploymentContext } from "../shared/supabase-deployment";
import { readSupabaseDeploymentBundle } from "./supabase-deployment-bundle";

/** Both repository and packaged resources retain the CLI's scripts/ + supabase/ layout. */
export async function readSupabaseSelfHostDeploymentContext(
  root: string,
  desktopVersion: string,
): Promise<SupabaseSelfHostDeploymentContext> {
  const supabaseDirectory = path.join(root, "supabase");
  const applyScriptPath = path.join(root, "scripts", "supabase-self-host-apply.mjs");
  const guidePath = path.join(root, "docs", "supabase-self-host.md");
  try {
    const [bundle] = await Promise.all([
      readSupabaseDeploymentBundle(supabaseDirectory, desktopVersion),
      access(applyScriptPath),
      access(guidePath),
    ]);
    return { backendVersion: bundle.version.release, supabaseDirectory, applyScriptPath, guidePath };
  } catch (cause) {
    throw new Error(`无法准备自托管部署资源：${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}
