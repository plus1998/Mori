/** Shared helpers for Eco HTML page hosting Edge Functions. */

export const HTML_PAGE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HTML_PAGE_EXTEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HTML_PAGE_MAX_BODY_CHARS = 1_048_576;
export const HTML_PAGE_MAX_TITLE_CHARS = 200;
export const HTML_PAGE_MAX_PER_USER = 50;
export const HTML_PAGE_SLUG_BYTES = 18;

export interface HtmlPageRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  body_html: string;
  thread_id: string | null;
  created_at: string;
  expires_at: string;
  extended_at: string | null;
}

export function createHtmlPageSlug(): string {
  const bytes = new Uint8Array(HTML_PAGE_SLUG_BYTES);
  crypto.getRandomValues(bytes);
  let out = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  for (const b of bytes) {
    out += alphabet[b % alphabet.length]!;
  }
  return out;
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms <= now;
}

/** Show extend when not yet extended and still within the first 7-day window from creation. */
export function canExtendPage(page: Pick<HtmlPageRow, "created_at" | "expires_at" | "extended_at">, now = Date.now()): boolean {
  if (page.extended_at) return false;
  if (isExpired(page.expires_at, now)) return false;
  const created = Date.parse(page.created_at);
  if (!Number.isFinite(created)) return false;
  return now - created < HTML_PAGE_DEFAULT_TTL_MS;
}

export function extractSlugFromUrl(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  // .../html-page-view/<slug> or .../functions/v1/html-page-view/<slug>
  const viewIdx = parts.findIndex((p) => p === "html-page-view");
  if (viewIdx >= 0 && parts[viewIdx + 1]) {
    return parts[viewIdx + 1]!;
  }
  const querySlug = url.searchParams.get("slug")?.trim();
  return querySlug || null;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Pull inner document for iframe srcdoc; keep scripts/styles from agent content. */
export function extractEmbeddableHtml(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const bodyMatch = trimmed.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1] !== undefined) {
    const headMatch = trimmed.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    const head = headMatch?.[1]?.trim() ?? "";
    const body = bodyMatch[1].trim();
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>${head}</head><body>${body}</body></html>`;
  }
  if (/^<!DOCTYPE/i.test(trimmed) || /<html\b/i.test(trimmed)) {
    return trimmed;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>${trimmed}</body></html>`;
}

export function buildPublicViewUrl(supabaseUrl: string, slug: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/html-page-view/${encodeURIComponent(slug)}`;
}

export function buildExtendUrl(supabaseUrl: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/html-page-extend`;
}

/** Desktop splash-icon.png @ 48px — embedded so Edge Functions need no static host. */
export const ECO_MARK_DATA_URI = "data:image/png;base64,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";

function ecoChromeCss(): string {
  return `
    :root {
      color-scheme: dark light;
      --bg-main: #212121;
      --bg-bar: #1a1a1a;
      --bg-elevated: #2b2b2b;
      --bg-elevated-hover: #323232;
      --text-primary: #e8e8e8;
      --text-heading: #f5f5f5;
      --text-muted: #8a8a8a;
      --border-subtle: #383838;
      --border-chrome: rgba(255, 255, 255, 0.1);
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --danger: #f87171;
      --success: #86efac;
      --primary-btn-bg: #f0f0f0;
      --primary-btn-text: #1a1a1a;
      --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg-main: #ffffff;
        --bg-bar: #fcfbfb;
        --bg-elevated: #ffffff;
        --bg-elevated-hover: #f5f5f7;
        --text-primary: #1d1d1f;
        --text-heading: #1d1d1f;
        --text-muted: #86868b;
        --border-subtle: #e5e5ea;
        --border-chrome: rgba(0, 0, 0, 0.06);
        --accent: #007aff;
        --accent-hover: #0066d6;
        --danger: #d70015;
        --success: #248a3d;
        --primary-btn-bg: #1d1d1f;
        --primary-btn-text: #ffffff;
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      height: 100%;
      background: var(--bg-main);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
    }
    .eco-shell { display: flex; flex-direction: column; height: 100%; min-height: 100%; }
    .eco-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      flex-shrink: 0;
      padding: 10px 14px;
      background: var(--bg-bar);
      border-bottom: 0.5px solid var(--border-chrome);
    }
    .eco-brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      min-width: 0;
      color: var(--text-heading);
      font-weight: 600;
      font-size: 14px;
      letter-spacing: -0.01em;
      text-decoration: none;
      user-select: none;
    }
    .eco-brand__logo {
      display: block;
      width: 22px;
      height: 22px;
      object-fit: contain;
      border-radius: 5px;
      flex-shrink: 0;
    }
    .eco-brand__name { line-height: 1; }
    .eco-title {
      flex: 1 1 10rem;
      min-width: 0;
      font-weight: 500;
      font-size: 13px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .eco-meta {
      color: var(--text-muted);
      font-size: 12px;
      flex-shrink: 0;
    }
    .eco-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      margin-left: auto;
    }
    .eco-btn {
      appearance: none;
      border: 0;
      border-radius: 8px;
      padding: 6px 12px;
      background: var(--primary-btn-bg);
      color: var(--primary-btn-text);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.2;
    }
    .eco-btn:hover:not(:disabled) { filter: brightness(0.96); }
    .eco-btn:disabled { opacity: 0.55; cursor: default; }
    .eco-btn:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
      outline-offset: 2px;
    }
    .eco-msg { color: var(--text-muted); font-size: 12px; }
    .eco-msg.is-error { color: var(--danger); }
    .eco-msg.is-ok { color: var(--success); }
    .eco-frame-wrap { flex: 1; min-height: 0; background: var(--bg-main); }
    .eco-frame { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
    .eco-status {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 32px 24px;
      text-align: center;
    }
    .eco-status__card {
      max-width: 28rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .eco-status__logo {
      width: 48px;
      height: 48px;
      object-fit: contain;
      border-radius: 12px;
    }
    .eco-status__title {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-heading);
      letter-spacing: -0.02em;
    }
    .eco-status__copy {
      margin: 0;
      color: var(--text-muted);
      line-height: 1.55;
      font-size: 14px;
    }
  `.trim();
}

function ecoBrandMarkup(): string {
  return `<div class="eco-brand" aria-label="Mori">
      <img class="eco-brand__logo" src="${ECO_MARK_DATA_URI}" width="22" height="22" alt="" />
      <span class="eco-brand__name">Mori</span>
    </div>`;
}

export function buildOuterFrameHtml(input: {
  title: string;
  slug: string;
  expiresAt: string;
  canExtend: boolean;
  bodyHtml: string;
  extendUrl: string;
  anonKey: string;
}): string {
  const title = escapeHtml(input.title);
  const expiresLabel = escapeHtml(
    new Date(input.expiresAt).toISOString().replace("T", " ").slice(0, 19) + " UTC",
  );
  const embed = extractEmbeddableHtml(input.bodyHtml);
  const srcdoc = escapeHtml(embed);
  const extendBlock = input.canExtend
    ? `<button type="button" id="eco-extend" class="eco-btn">延期 7 天</button>
       <span id="eco-extend-msg" class="eco-msg" hidden></span>`
    : `<span class="eco-msg">已超过默认 7 天窗口或已延期，无法再次延期。</span>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Mori</title>
  <style>
${ecoChromeCss()}
  </style>
</head>
<body>
  <div class="eco-shell">
    <header class="eco-bar">
      ${ecoBrandMarkup()}
      <div class="eco-title" title="${title}">${title}</div>
      <div class="eco-actions">
        <div class="eco-meta">过期 ${expiresLabel}</div>
        ${extendBlock}
      </div>
    </header>
    <div class="eco-frame-wrap">
      <iframe class="eco-frame" title="${title}" sandbox="allow-scripts allow-forms allow-modals" srcdoc="${srcdoc}"></iframe>
    </div>
  </div>
  ${
    input.canExtend
      ? `<script>
(function () {
  var btn = document.getElementById("eco-extend");
  var msg = document.getElementById("eco-extend-msg");
  if (!btn) return;
  btn.addEventListener("click", function () {
    btn.disabled = true;
    msg.hidden = false;
    msg.className = "eco-msg";
    msg.textContent = "延期中…";
    fetch(${JSON.stringify(input.extendUrl)}, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": ${JSON.stringify(input.anonKey)} },
      body: JSON.stringify({ slug: ${JSON.stringify(input.slug)} })
    }).then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) {
          msg.className = "eco-msg is-error";
          msg.textContent = (result.body && (result.body.error || result.body.message)) || "延期失败";
          btn.disabled = false;
          return;
        }
        msg.className = "eco-msg is-ok";
        msg.textContent = "已延期至 " + (result.body.expiresAt || "").replace("T", " ").slice(0, 19) + " UTC";
        btn.remove();
      }).catch(function (err) {
        msg.className = "eco-msg is-error";
        msg.textContent = String(err && err.message ? err.message : err);
        btn.disabled = false;
      });
  });
})();
</script>`
      : ""
  }
</body>
</html>`;
}

/** Shared Eco-branded status / error page for view Edge Function. */
export function buildStatusPageHtml(input: { title?: string; zh: string; en: string }): string {
  const pageTitle = escapeHtml(input.title?.trim() || "Mori");
  const zh = escapeHtml(input.zh);
  const en = escapeHtml(input.en);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <style>
${ecoChromeCss()}
  </style>
</head>
<body>
  <div class="eco-shell">
    <header class="eco-bar">
      ${ecoBrandMarkup()}
    </header>
    <main class="eco-status">
      <div class="eco-status__card">
        <img class="eco-status__logo" src="${ECO_MARK_DATA_URI}" width="48" height="48" alt="" />
        <h1 class="eco-status__title">${pageTitle}</h1>
        <p class="eco-status__copy">${zh}</p>
        <p class="eco-status__copy" lang="en">${en}</p>
      </div>
    </main>
  </div>
</body>
</html>`;
}
