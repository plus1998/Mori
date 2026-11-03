/**
 * Public HTML page view with Mori outer chrome (not authored by the agent).
 */
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  buildExtendUrl,
  buildOuterFrameHtml,
  buildStatusPageHtml,
  canExtendPage,
  extractSlugFromUrl,
  isExpired,
  resolvePublicSupabaseUrl,
  type HtmlPageRow,
} from "../_shared/html-pages.ts";
import { createServiceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(req.url);
  const slug = extractSlugFromUrl(url);
  if (!slug) {
    return htmlResponse(400, buildStatusPageHtml({ zh: "缺少页面 slug。", en: "Missing page slug." }));
  }

  try {
    const admin = createServiceClient();
    const publicSupabaseUrl = resolvePublicSupabaseUrl(req, Deno.env.get("SUPABASE_PUBLIC_URL"));

    const { data, error } = await admin.from("html_pages").select("*").eq("slug", slug).maybeSingle();
    if (error) {
      console.error(error);
      return htmlResponse(500, buildStatusPageHtml({ zh: "读取失败。", en: "Failed to load page." }));
    }
    if (!data) {
      return htmlResponse(404, buildStatusPageHtml({ zh: "页面不存在。", en: "Page not found." }));
    }

    const page = data as HtmlPageRow;
    if (isExpired(page.expires_at)) {
      return htmlResponse(410, buildStatusPageHtml({ title: "已过期", zh: "页面已过期。", en: "This page has expired." }));
    }

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const frame = buildOuterFrameHtml({
      title: page.title,
      slug: page.slug,
      expiresAt: page.expires_at,
      canExtend: canExtendPage(page),
      bodyHtml: page.body_html,
      extendUrl: buildExtendUrl(publicSupabaseUrl),
      anonKey,
    });

    return new Response(req.method === "HEAD" ? null : frame, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(error);
    return htmlResponse(500, buildStatusPageHtml({ zh: "内部错误。", en: "Internal error." }));
  }
});

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
