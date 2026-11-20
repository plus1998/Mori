export const ECO_HTML_HOST_MCP_SERVER = "mori_html_host";
export const ECO_HTML_HOST_TOOL = "publish_html";
export const ECO_HTML_HOST_FULL_TOOL = `mcp__${ECO_HTML_HOST_MCP_SERVER}__${ECO_HTML_HOST_TOOL}`;

export type HtmlHostingCapabilityReason =
  | "ok"
  | "not_connected"
  | "probe_failed"
  | "content_type_rewritten"
  | "function_missing"
  | "unchecked";

export interface HtmlHostingCapability {
  /** Function reachable — publish_html may be injected. */
  available: boolean;
  reason: HtmlHostingCapabilityReason;
  /**
   * True when Cloud shared domain rewrote text/html → text/plain.
   * Feature stays enabled; external share links may show source instead of rendering.
   */
  renderRisk?: boolean;
  checkedAt?: string;
  detail?: string;
  contentType?: string;
}

export type HtmlHostArtifactStatus = "completed" | "failed";

export interface HtmlHostArtifact {
  id: string;
  threadId: string;
  toolUseId?: string;
  status: HtmlHostArtifactStatus;
  pageId: string;
  slug: string;
  title: string;
  publicUrl: string;
  expiresAt: string;
  extendedAt?: string;
  canExtend: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HtmlHostToolInput {
  title: string;
  html: string;
  pageId?: string;
}

export interface HtmlHostPublishResult {
  pageId: string;
  slug: string;
  title: string;
  publicUrl: string;
  expiresAt: string;
  extendedAt?: string | null;
  canExtend: boolean;
  createdAt: string;
}

export function buildHtmlPageViewUrl(supabaseUrl: string, slug: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/html-page-view/${encodeURIComponent(slug)}`;
}

export function buildHtmlHostProbeUrl(supabaseUrl: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/html-host-probe`;
}
