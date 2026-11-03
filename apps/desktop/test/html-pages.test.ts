import { expect, test } from "bun:test";
import {
  buildExtendUrl,
  buildOuterFrameHtml,
  buildPublicViewUrl,
  buildStatusPageHtml,
  resolvePublicSupabaseUrl,
} from "../../../supabase/functions/_shared/html-pages";

test("self-hosted HTML links use SUPABASE_PUBLIC_URL, including a proxy path", () => {
  const req = new Request("http://functions:9000/html-page-publish");
  const base = resolvePublicSupabaseUrl(req, "https://center.example.com/supabase/");
  expect(buildPublicViewUrl(base, "a/b")).toBe(
    "https://center.example.com/supabase/functions/v1/html-page-view/a%2Fb",
  );
  expect(buildExtendUrl(base)).toBe("https://center.example.com/supabase/functions/v1/html-page-extend");
});

test("proxied HTML requests retain the external HTTPS host and port", () => {
  const req = new Request("http://functions:9000/html-page-view/slug", {
    headers: {
      "x-forwarded-host": "center.example.com:8443, proxy.internal",
      "x-forwarded-proto": "https, http",
    },
  });
  expect(resolvePublicSupabaseUrl(req)).toBe("https://center.example.com:8443");
});

test("Cloud and direct local requests retain their public origin", () => {
  expect(resolvePublicSupabaseUrl(new Request("https://project.supabase.co/functions/v1/html-page-publish")))
    .toBe("https://project.supabase.co");
  expect(resolvePublicSupabaseUrl(new Request("http://localhost:8000/functions/v1/html-page-publish")))
    .toBe("http://localhost:8000");
});

test("hosted content, expiry controls and status pages use Mori branding", () => {
  const html = buildOuterFrameHtml({
    title: "Report",
    slug: "slug",
    expiresAt: "2030-01-08T00:00:00.000Z",
    canExtend: true,
    bodyHtml: "<h1>Report</h1>",
    extendUrl: buildExtendUrl("https://center.example.com"),
    anonKey: "anon",
  });
  expect(html).toContain("<title>Report — Mori</title>");
  expect(html).toContain('aria-label="Mori"');
  expect(html).toContain("https://center.example.com/functions/v1/html-page-extend");
  expect(html).not.toContain("EcoCoding");
  const status = buildStatusPageHtml({ zh: "页面已过期。", en: "This page has expired." });
  expect(status).toContain("<title>Mori</title>");
  expect(status).toContain('class="eco-brand__name">Mori</span>');
  expect(status).not.toContain("EcoCoding");
});
