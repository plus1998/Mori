/**
 * Capability probe: returns text/html when allowed by the platform.
 * Desktop enables HTML hosting when the function responds OK.
 * Cloud shared domains may rewrite Content-Type to text/plain — Eco still enables
 * publish and surfaces a render-risk hint in Settings.
 */
import { corsHeaders, handleCors } from "../_shared/cors.ts";

Deno.serve((req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Mori HTML host probe</title></head><body>ok</body></html>`;
  return new Response(req.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Eco-Html-Host-Probe": "1",
    },
  });
});
