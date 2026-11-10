import { handleHtmlPageView } from "../functions/html-page-view/handler.ts";
import { handleHtmlPagePublish } from "../functions/html-page-publish/handler.ts";

const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const mediaId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const prefix = `${userId}/cccccccc-cccc-cccc-cccc-cccccccccccc`;
const basePage = { id: "page", user_id: userId, slug: "snapshot", title: "Snapshot", body_html: `<img src="mori-share-media:${mediaId}">`,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  extended_at: null, is_snapshot: true, share_media_prefix: prefix };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("snapshot media checks expiry and identity before signing, and resolves a public proxy URL", async () => {
  Deno.env.set("SUPABASE_URL", "http://internal.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  Deno.env.set("SUPABASE_PUBLIC_URL", "https://public.test/proxy");
  Deno.env.set("SUPABASE_ANON_KEY", "anon");
  const originalFetch = globalThis.fetch;
  let page = { ...basePage };
  let signedCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/rest/v1/html_pages")) return Response.json([page]);
    if (url.includes("/storage/v1/object/sign/")) {
      signedCalls++;
      assert(url.endsWith(`${prefix}/${mediaId}`), "sign only media belonging to this snapshot");
      assert(JSON.parse(String(init?.body)).expiresIn === 60, "signed access is short lived");
      return Response.json({ signedURL: `/object/sign/conversation-share-media/${prefix}/${mediaId}?token=test` });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const url = `https://public.test/proxy/functions/v1/html-page-view/snapshot?media=${mediaId}`;
    const valid = await handleHtmlPageView(new Request(url));
    assert(valid.status === 307, "valid media redirects to signed storage");
    assert(valid.headers.get("location") === `https://public.test/proxy/storage/v1/object/sign/conversation-share-media/${prefix}/${mediaId}?token=test`, "redirect uses public URL");
    page.expires_at = "2000-01-01T00:00:00Z";
    assert((await handleHtmlPageView(new Request(url))).status === 410, "expired media is unavailable");
    page = { ...basePage };
    assert((await handleHtmlPageView(new Request(url.replace(mediaId, "../private")))).status === 404, "invalid media ID is rejected");
    page.is_snapshot = false;
    assert((await handleHtmlPageView(new Request(url))).status === 404, "regular HTML pages cannot expose media");
    assert(signedCalls === 1, "rejected requests never sign storage objects");
    page = { ...basePage };
    const view = await handleHtmlPageView(new Request(url.split("?")[0]));
    const html = await view.text();
    assert(view.status === 200 && html.includes(`snapshot?media=${mediaId}`), "view resolves snapshot media");
    assert(!html.includes("mori-share-media:"), "view contains no unresolved media references");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("snapshot publish rejects overwrites and media prefixes owned by other users", async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: userId });
    if (url.includes("/rest/v1/html_pages")) {
      if (init?.method && init.method !== "GET") writes++;
      return Response.json([basePage]);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const request = (body: unknown) => new Request("https://public.test/functions/v1/html-page-publish", {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const update = await handleHtmlPagePublish(request({ title: "new", html: "new", pageId: "page" }));
    assert(update.status === 409, "snapshot body cannot be updated");
    const otherOwner = await handleHtmlPagePublish(request({ title: "new", html: "new", isSnapshot: true,
      shareMediaPrefix: `dddddddd-dddd-dddd-dddd-dddddddddddd/cccccccc-cccc-cccc-cccc-cccccccccccc` }));
    assert(otherOwner.status === 400, "cannot publish another user's media prefix");
    assert(writes === 0, "rejected publishing requests never write to database");
  } finally { globalThis.fetch = originalFetch; }
});
