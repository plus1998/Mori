import { expect, test } from "bun:test";
import { buildCodexGatewayModelAlias } from "@eco/shared";
import {
  makeStack,
  modelOutputs,
  protocols,
  roles,
  windows,
} from "../../../scripts/output-budget-matrix/stack";
import { buildPiGatewayRequestHeaders } from "../src/main/gateway-route-binding";

for (const core of ["claude", "codex", "pi"] as const)
  for (const protocol of protocols) {
    test(`${core} main + all built-in children → ${protocol}, stream/non-stream, high/low/missing budget`, async () => {
      const stack = await makeStack(protocol, core);
      try {
        for (const [i, role] of roles.entries())
          for (const stream of [false, true])
            for (const input of [100, windows[i]! - 101])
              for (const requested of [undefined, 128_000, 32_000, 1_600]) {
                const route = stack.binding.routes.find((r) => r.role === role)!;
                const face =
                  core === "claude" || (core === "pi" && protocol === "anthropic")
                    ? "messages"
                    : core === "pi" && protocol === "chat"
                      ? "chat/completions"
                      : "responses";
                const model =
                  core === "codex"
                    ? buildCodexGatewayModelAlias("matrix", `${protocol}__${role}`)
                    : route.aliasModelId;
                const body = {
                  model,
                  stream,
                  ...(face === "responses"
                    ? { input: [{ role: "user", content: `OUTPUT_BUDGET_PROBE MATRIX_INPUT_${input}` }] }
                    : { messages: [{ role: "user", content: `OUTPUT_BUDGET_PROBE MATRIX_INPUT_${input}` }] }),
                  ...(requested !== undefined && {
                    [face === "responses" ? "max_output_tokens" : "max_tokens"]: requested,
                  }),
                };
                const headers = {
                  "content-type": "application/json",
                  ...(core !== "codex" && { authorization: `Bearer ${stack.binding.apiKey}` }),
                  ...(core === "pi" &&
                    buildPiGatewayRequestHeaders({
                      bindingId: stack.binding.bindingId,
                      threadId: `matrix_pi_${protocol}`,
                      providerId: "matrix",
                      requestedModel: model,
                      apiCompat: route.apiCompat,
                    })),
                };
                const response = await fetch(`${stack.binding.baseUrl}/v1/${face}`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(body),
                });
                const text = await response.text();
                expect(response.status).toBe(200);
                expect(text).toContain("OUTPUT_BUDGET_OK");
                const trace = stack.traces.at(-1)!;
                expect(trace.role).toBe(role);
                expect(trace.path).toBe(
                  `/v1/${protocol === "anthropic" ? "messages" : protocol === "chat" ? "chat/completions" : "responses"}`,
                );
                const expected = Math.min(windows[i]! - input - 1, modelOutputs[i]!);
                expect(trace.output).toBe(expected);
                expect(trace.input + Number(trace.output)).toBeLessThan(windows[i]!);
              }
      } finally {
        await stack.stop();
      }
    }, 30_000);
  }
