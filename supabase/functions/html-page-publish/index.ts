/**
 * Authenticated publish/update for Mori HTML pages.
 */
import { handleCors } from "../_shared/cors.ts";
import {
  buildPublicViewUrl,
  canExtendPage,
  createHtmlPageSlug,
  HTML_PAGE_DEFAULT_TTL_MS,
  HTML_PAGE_MAX_BODY_CHARS,
  HTML_PAGE_MAX_PER_USER,
  HTML_PAGE_MAX_TITLE_CHARS,
  resolvePublicSupabaseUrl,
  type HtmlPageRow,
} from "../_shared/html-pages.ts";
import {
  errorResponse,
  HttpError,
  json,
  readJsonObject,
  requireMethod,
  requireString,
} from "../_shared/http.ts";
import { createServiceClient, requireAuthSession } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    requireMethod(req, "POST");
    const auth = await requireAuthSession(req);
    const body = await readJsonObject(req);
    const title = requireString(body, "title").slice(0, HTML_PAGE_MAX_TITLE_CHARS);
    const htmlRaw = requireString(body, "html");
    if (htmlRaw.length > HTML_PAGE_MAX_BODY_CHARS) {
      throw new HttpError(413, "html exceeds 1 MiB limit.", "body_too_large");
    }
    const pageId =
      typeof body.pageId === "string" && body.pageId.trim()
        ? body.pageId.trim()
        : typeof body.page_id === "string" && body.page_id.trim()
          ? body.page_id.trim()
          : undefined;
    const threadId =
      typeof body.threadId === "string" && body.threadId.trim()
        ? body.threadId.trim()
        : typeof body.thread_id === "string" && body.thread_id.trim()
          ? body.thread_id.trim()
          : null;

    const admin = createServiceClient();
    const publicSupabaseUrl = resolvePublicSupabaseUrl(req, Deno.env.get("SUPABASE_PUBLIC_URL"));

    let page: HtmlPageRow;

    if (pageId) {
      const { data: existing, error: loadError } = await admin
        .from("html_pages")
        .select("*")
        .eq("id", pageId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (loadError) {
        throw new HttpError(500, loadError.message, "db_error");
      }
      if (!existing) {
        throw new HttpError(404, "HTML page not found.", "not_found");
      }
      const { data: updated, error: updateError } = await admin
        .from("html_pages")
        .update({
          title,
          body_html: htmlRaw,
          ...(threadId ? { thread_id: threadId } : {}),
        })
        .eq("id", pageId)
        .eq("user_id", auth.user.id)
        .select("*")
        .single();
      if (updateError || !updated) {
        throw new HttpError(500, updateError?.message ?? "Update failed.", "db_error");
      }
      page = updated as HtmlPageRow;
    } else {
      const { count, error: countError } = await admin
        .from("html_pages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", auth.user.id)
        .gt("expires_at", new Date().toISOString());
      if (countError) {
        throw new HttpError(500, countError.message, "db_error");
      }
      if ((count ?? 0) >= HTML_PAGE_MAX_PER_USER) {
        throw new HttpError(429, "Too many active HTML pages (max 50).", "quota_exceeded");
      }

      const now = Date.now();
      const slug = createHtmlPageSlug();
      const { data: inserted, error: insertError } = await admin
        .from("html_pages")
        .insert({
          user_id: auth.user.id,
          slug,
          title,
          body_html: htmlRaw,
          thread_id: threadId,
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + HTML_PAGE_DEFAULT_TTL_MS).toISOString(),
          extended_at: null,
        })
        .select("*")
        .single();
      if (insertError || !inserted) {
        throw new HttpError(500, insertError?.message ?? "Insert failed.", "db_error");
      }
      page = inserted as HtmlPageRow;
    }

    const publicUrl = buildPublicViewUrl(publicSupabaseUrl, page.slug);
    return json(
      {
        pageId: page.id,
        slug: page.slug,
        title: page.title,
        publicUrl,
        expiresAt: page.expires_at,
        extendedAt: page.extended_at,
        canExtend: canExtendPage(page),
        createdAt: page.created_at,
      },
      pageId ? 200 : 201,
    );
  } catch (error) {
    return errorResponse(error);
  }
});
