# Gateway HTTP round replay

Higher-bar golden tests for **Mori Gateway** HTTP faces.

## Protocol profiles

| Profile | Protocol | Upstream | Model |
|---|---|---|---|
| `packy_responses` | OpenAI Responses | `https://gpt.pomener.ru/v1/responses` | `gpt-5.6-luna` |
| `packy_anthropic` | Anthropic Messages | `https://www.packyapi.ai/v1/messages` | `claude-sonnet-5` |
| `longcat_chat` | OpenAI Chat Completions | `https://api.longcat.chat/openai/v1/chat/completions` | `LongCat-2.0` |
| `longcat_responses` | OpenAI Responses | `https://api.longcat.chat/openai/v1/responses` | `LongCat-2.0` | *(optional; not in 3×3 matrix)* |

## Coverage matrix (client-round)

Each cell runs the **full conversation-round scenario** (skills, file write/read, MCP `smoke_ping`, subagent, marker) through **Mori Bridge → embedded Gateway**, recording every upstream HTTP exchange.

Explicit **3×3** matrix (`RECORDING_CELL_SPECS`):

| Client | Gateway face | Responses (Luna @ Pomener) | Anthropic (Packy) | Chat (LongCat) |
|---|---|---|---|---|
| **Codex** | `/v1/responses` | `packy_responses` | `packy_anthropic` | `longcat_chat` |
| **Claude Code** | `/v1/messages` | `packy_responses` | `packy_anthropic` | `longcat_chat` |
| **PI (π)** | native per apiCompat | `packy_responses` | `packy_anthropic` | `longcat_chat` |

All three clients share the same upstream per protocol column. Claude/PI Responses hit gateway `messages→responses` then Pomener `/v1/responses`.

Scenario checklist keys (shared with `conversation-round`):

- `skills_listed` / `skill_invoked_or_mentioned`
- `file_written` / `file_read_back`
- `mcp_tool_called` (`smoke_ping` / `smoke_echo`)
- `subagent_spawned` / `subagent_turn_events`
- `turn_completed` / `marker_in_assistant`

## Record full client-round matrix (recommended)

```bash
export GATEWAY_RECORD_RESPONSES_KEY=sk-...
export GATEWAY_RECORD_PACKY_ANTHROPIC_KEY=sk-...
export GATEWAY_RECORD_LONGCAT_CHAT_KEY=ak_...

bun run round -- gateway record
# or: bun scripts/gateway-http-round/record-client-round.mts
```

Options:

```bash
bun run round -- gateway record --client=codex --profile=packy_responses
bun run round -- gateway record --client=claude --profile=longcat_responses
bun run round -- gateway record --client=pi --profile=longcat_chat
```

Artifacts:

```
scripts/gateway-http-round/fixtures/<runId>/
  upstream-via-gateway.jsonl       # all cells (tagged client + profileId)
  artifacts/                       # raw upstream bodies
  summary.json
  codex/packy_responses/
    upstream-via-gateway.jsonl     # cell-filtered
    rpc-log.jsonl                  # Codex JSON-RPC sidecar
    checklist.json
    workspace-files.json
    prompt.txt
  claude/packy_anthropic/
    sdk-messages.jsonl
    agent-events.jsonl
    ...
  pi/longcat_chat/
    pi-sdk-events.jsonl
    agent-events.jsonl
    ...
```

## Record minimal HTTP probes (no tools)

### Upstream (raw HTTP, bypass gateway)

```bash
bun run round -- gateway record --layer=upstream
bun run round -- gateway record --layer=upstream --profile=packy_anthropic
```

### Gateway handler (synthetic fetch client)

```bash
bun run round -- gateway record --layer=gateway
```

Scenarios: `text_non_stream`, `text_stream` only.

## Replay tests

```bash
bun run round -- gateway replay
```

Feed replay tests rebuild the Feed projection from recorded `rpc-log.jsonl` (Codex) or `agent-events.jsonl` (Claude/PI) and assert scenario coverage.

### Visual Feed replay (demo mode)

Replay recorded cells in the Demo UI — sidebar lists each cell as a thread; Feed shows the rebuilt projection.

```bash
# all discovered 3×3 cells
bun run round -- gateway demo

# single cell (protocol aliases — no need to remember packy/longcat)
bun run round -- gateway demo claude:responses
bun run round -- gateway demo pi/messages
bun run round -- gateway demo codex:chat_completions

# all 3 protocols for one client
bun run round -- gateway demo claude:responses/messages/chat_completions

# selector help
bun run round -- gateway demo help

# restrict fixture run
ECO_DEMO_FEED_REPLAY_FIXTURE=2026-09-01T07-40-15Z-claude-pi-round bun run round -- gateway demo
```

Env:

- `ECO_DEMO_FEED_REPLAY=matrix|all|codex:packy_responses` — which cells to load
- `ECO_DEMO_FEED_REPLAY_FIXTURE` — optional fixture run dir/runId

Gateway HTTP handler replay (minimal probes only):

```bash
ECO_GATEWAY_HTTP_ROUND_FIXTURE_GATEWAY=scripts/gateway-http-round/fixtures/<runId> \
  bun test apps/gateway/test/gateway-http-round-replay.test.ts
```

## Notes

- **Luna Responses** (`GATEWAY_RECORD_RESPONSES_KEY` → `https://gpt.pomener.ru`) is shared by Codex, Claude, and PI in the 3×3 matrix.
- Profiles without env keys are skipped (not failed) when using `--profile=all`.
- Secrets are **never** written to fixtures (redacted). Store keys only in env.
- Prefer `bun run round -- gateway record --client=codex --profile=packy_responses` (legacy `record-codex-via-gateway.mts` is the same).
