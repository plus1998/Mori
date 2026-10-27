/**
 * Public landing page after Auth email confirmation redirect.
 * No JWT — users open this from the email link in a browser.
 */
Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type",
      },
    });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mori — 邮箱已确认</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #0f1419;
      color: #e7ecf3;
      padding: 24px;
    }
    main {
      max-width: 28rem;
      text-align: center;
      line-height: 1.55;
    }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.75rem; }
    p { margin: 0 0 0.75rem; color: #a9b4c4; }
    .ok { color: #7ddea0; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1 class="ok">邮箱已确认</h1>
    <p>你的 Mori 账号邮箱已验证成功。</p>
    <p>请返回 <strong>Mori Desktop</strong>，用同一邮箱和密码点击「登录并绑定」。</p>
    <p lang="en">Email confirmed. Return to Mori Desktop and sign in.</p>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});
