# Dynamic max-output verification

The matrix covers Claude Code, Codex, and PI against Responses, Anthropic Messages,
and Chat Completions upstreams. Every cell includes planner and all five built-in
child roles: explore, architect, coder, reviewer, and tester.

## HTTP regression matrix

```sh
bun test apps/desktop/test/max-output-agent-endpoint-matrix.test.ts
```

Nine tests execute 648 requests through the production route binding, SDK Bridge,
embedded Gateway, protocol conversion, and a local upstream HTTP server. Each role
has a distinct context/output budget. Cases cover streaming/non-streaming requests
and missing, oversized, and smaller client output limits. Short and nearly-full
window cases use controlled input counts to verify `W - input - 1` for each request.
Assertions inspect the
final upstream request and consume the complete response.

The verification harness can also be type-checked independently:

```sh
bunx tsc -p scripts/output-budget-matrix/tsconfig.json
```

## Real SDK and CLI matrix

```sh
bun scripts/output-budget-matrix/native.mts
# Optional single core or upstream:
bun scripts/output-budget-matrix/native.mts --core=codex --protocol=responses
```

Uses installed Claude SDK/native CLI, Codex app-server, and PI SDK. The deterministic
local upstream emits delegation tool calls so each parent actually starts all five
children. PI uses the desktop's createPiSubagentSpawnHandler. Codex child threads
must complete with the marker; merely accepting spawn_agent does not pass.

Reports and request-budget traces are saved under:

`apps/desktop/.smoke-artifacts/output-budget-matrix/`

The upstream server is local and returns deterministic model replies. This verifies
real SDK/CLI request construction, child execution, Bridge/Gateway routing, and
output-cap propagation. Real SDK traces use the production `local_heuristic` provider
counting mode, explicitly an estimate. Exact provider count modes preserve the final
native payload and fail on unsupported endpoints or protocol mismatches; they never
fall back to a heuristic. Unit tests cover failure, exhaustion, and rectified retries.
This does **not** verify remote provider compliance or real
model compaction near a full context window. ChatGPT subscription transport does
not support max_output_tokens; dynamic mode rejects that transport explicitly.

All clients use isolated temporary workspaces and local credentials. No remote API
credentials are needed, and application settings are not modified.
