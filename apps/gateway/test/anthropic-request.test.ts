import { expect, test } from "bun:test";
import { pickAnthropicClientHeaders, withAnthropicBetaQuery } from "../src/upstream/anthropic-request";

test("protocol metadata is forwarded only when supplied by the actual caller", () => {
  expect(pickAnthropicClientHeaders(new Headers())).toEqual({});
  expect(pickAnthropicClientHeaders(new Headers({
    "x-api-key": "binding-secret", authorization: "Bearer local-secret", cookie: "private",
    "x-eco-agent-core": "claude", "x-gateway-provider-id": "local", "x-stainless-lang": "js", "x-app": "cli",
  }))).toEqual({ "x-stainless-lang": "js", "x-app": "cli" });
});

test("beta selection preserves the upstream query and excludes unrelated local parameters", () => {
  const upstream = "https://upstream.test/v1/messages?existing=value";
  expect(withAnthropicBetaQuery(upstream, "http://localhost/v1/messages?beta=true&secret=private"))
    .toBe(`${upstream}&beta=true`);
  expect(withAnthropicBetaQuery(upstream, "http://localhost/v1/messages?beta=false")).toBe(upstream);
  expect(withAnthropicBetaQuery(upstream)).toBe(upstream);
});
