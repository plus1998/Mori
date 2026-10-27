# Mori Technical Documentation

[简体中文](TECHNICAL.md) · **English** · [README](../README.en.md) · [User Guide](USER_GUIDE.en.md)

This document describes the implemented architecture and boundaries of the current Beta for contributors, integrators, and operators of a user-owned Supabase Center. The code remains the final source of truth.

## 1. System architecture

```mermaid
flowchart LR
    U["User"] --> D["Desktop Renderer\nReact + Vite"]
    D <--> P["Preload / Typed IPC"]
    P <--> M["Electron Main"]
    M --> R["Agent Runtime\nCodex / Claude Code"]
    R --> O["Lead Agent + Subagents"]
    R --> G["Embedded Model Gateway"]
    G --> A["Responses API"]
    G --> B["Anthropic Messages API"]
    G --> C["Chat Completions API"]
    M --> S["SQLite + System Keychain"]
    X["Flutter Mobile"] <--> SB["Supabase\nAuth + Realtime + Edge"]
    SB <--> M
```

### Components

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main, preload, React UI, local agent execution, packaging |
| `apps/gateway` | Routes or converts Harness traffic to supported upstream protocols |
| `supabase/` | User-owned Auth, devices/pairing, Realtime RPC, settings sync |
| `apps/mobile` | Flutter remote client; it does not edit code on the phone |
| `packages/runtime` | Harness adapters, session modes, context, billing, subagent runtime |
| `packages/shared` | Cross-client protocol constants and shared types |
| `packages/openai-anthropic-bridge` | OpenAI / Anthropic request and stream conversion |
| `packages/model-router` | Model and role routing |
| `packages/workspace` | Git workspace, Worktree, and change workflows |

## 2. Desktop process boundaries

The React Renderer owns projects, conversations, settings, activity feeds, approvals, diffs, and usage views. It does not read secrets or spawn model processes directly. A context-isolated preload exposes typed IPC, and Electron Main owns all privileged operations: Harness workers, model routing, Git, terminals, persistence, integrations, device RPC, and updates. Rewind truncates conversation history only; Mori does not snapshot or restore workspace files.

## 3. Harnesses

`ThreadRuntimeCoordinator` dispatches `claude`, `codex`, and `pi` Harnesses (`CoreKind`). Every conversation persists its own `coreKind`, so one project can contain sessions backed by different runtimes.

**PI (v1) boundary:** in-process `@earendil-works/pi-coding-agent` **1.0.3** SDK + Mori Gateway models; Mori Agent-tool subagents from the thread orchestration snapshot (capability=`eco`); tool approval capability=`eco` (`tool_call` → `createThreadToolPermissionHandler`); session modes Agent/Plan/Ask; plan approval capability=`eco` (`finalize_plan` → `plan.ready` persists a pending plan, the turn ends, user approves asynchronously then a new Agent turn runs; quit does not clear pending plans); Ask/Plan use read-only tools + read-only bash allowlist (not an OS sandbox; `read` goes through Mori workspace-scope policy — allow inside, ask outside; read-only bash remains mode-layer allowlisted); **not wired:** optional Windows `powershell` tool (community optional escape hatch when Git Bash is missing; Mori has no PS read-only Ask/Plan policy yet); **not wired:** `SessionManager.inMemory(entries)` restore (parent/child sessions stay on disk JSONL); **not enabled:** `compat.supportsMidConvoEffort` (pi docs require a faithful Anthropic Messages Claude transport; Mori Bridge/Gateway is not that); `ui_prompt_*` / `session_compact_failed` extension events are not bridged separately (approvals use Mori tool permissions; compaction failures already map from session `compaction_end`). No Mori compact/rewind handoff (PI native `compaction.enabled` owns compact; `pi-smart-compact` is not installed; 0.84.4+ compacts large tool results in-turn before the next provider call). Skills and MCP are Mori-injected per session (`skills: "eco"` / `mcp: "eco"`): discover `.agents/skills` and `.pi/skills` (plus `~/.agents/skills` / `~/.pi/agent/skills`), filter by thread `skillsEnabled`, and pass paths into the PI `ResourceLoader` with `includeDefaults: false`. MCP uses the **official** `createMcpExtension` fed from an in-memory snapshot with Composer-selected servers plus built-in integrations (browser/image) — `mcp.json` / `~/.pi` are neither read nor merged, and `updateConfig` fails loudly instead of pretending to write back (Mori owns no file to write to). Server tools surface under the official `mcp__<server>__<tool>` names; Mori hands the model only the Hub's `mcp__eco_mcp__search_tools` / `mcp__eco_mcp__call_tool` and sets exposure to `direct` (the official default, `codemode`, would hide the Hub behind a sandbox). Millisecond timeouts are converted to the official seconds, and SSE servers stay in the Mori MCP Hub. **Codemode** is registered via the official `createCodemodeExtension({ mode: "on", models: false })`; the tool is named `codemode` and appears only in the Agent allowlist. The sandbox reaches exactly the tools the session already allowed (minus `codemode` itself, so a script cannot re-enter it). Nested calls a script makes are flagged by PI with `parentToolCallId` (ids look like `<parent id>/<n>`), and the event bridge keeps that as `parent_tool_call_id` — deliberately **not** `parent_tool_use_id`, which means subagent ownership everywhere in Mori; a nested call carrying it would be treated as a subagent row and dropped from the timeline. `structuredContent` on a tool result is carried through as well. The pre-0.85.1 `mcp` / `mcpScript` tool names survive only on the replay-parsing path; new turns never emit them. Settings → Personalization global rules are injected into the parent session via `appendSystemPrompt` (before browser/image guidance); they are written into the ResourceLoader only when a session is created or rebuilt, so hot reuse does not refresh them when rules change; subagents use template prompts and do not receive global rules. Subagents are isolated `AgentSession`s under `pi-agent/<threadId>/subagents/<agentId>/` (empty history, no nesting) using that agent's Gateway model alias with no planner fallback. Each thread owns `ecoDataDir/pi-agent/<threadId>/` (private skill mounts, persisted `sessions/*.jsonl`, auth/models cache); Mori does **not** use the `~/.pi` default session directory. The in-process registry reuses the same `AgentSession` on the hot path; cold start opens the JSONL via `SessionManager.open` when identity + MCP fingerprints match. MCP set or cwd/provider/model/apiCompat/routes changes recreate an empty session and prune that thread's old jsonl files. Route `thinkingEffort` maps to PI `thinkingLevel` (`off`/`low`/`medium`/`high`/`xhigh`/`max` 1:1; unset or unknown fail-closes to `off`); `model.reasoning=true` and the identity fingerprint includes `:te=` only when not `off`, otherwise PI does not send thinking fields and the fingerprint stays compatible with older sessions. Mori has no PI `minimal` level and never emits it. Deleting a thread removes its `pi-agent/<threadId>` tree; Storage → All PI sessions deletes those Mori chats (they leave the sidebar) and clears `pi-agent/` (running/queued PI threads are skipped). Idle sessions hot-reload skills on the next run via `AgentSession.reload`; running sessions still block config edits. This is **visibility isolation**, not OS filesystem isolation — PI still has `read`/`bash`, so skill files in a shared workspace may remain readable. Built-in tools resolve paths against session `ctx.cwd` (PI 0.85.0+; multi-session in-process no longer uses stale create-time cwd).

**PI mid-turn steer:** follow-ups sent while a PI thread is running are injected into the current turn via `AgentSession.steer()` (delivered before the next model call, without starting a new turn). It is accepted only while the in-process parent session is streaming; when the session is idle, or when the run ends right before delivery, `createPiMidTurnHandle` reclaims the orphaned queue entry and fails closed, so Mori keeps the queued row and the post-run drain sends it as a fresh turn. Subagent sessions never answer thread-level steer.

The adapter layer describes Agent / Plan / Ask modes, compaction, conversation rewind (workspace files are not restored), approvals, MCP, Skills, and subagents. Mori preserves native Harness behavior where possible and explicitly labels capabilities implemented by Mori or unavailable instead of presenting them as native.

## 4. Multi-agent orchestration

A runtime configuration consists of:

1. `MainAgentConfigResource`: lead model, tools, Skills, and capability policy.
2. `MainAgentPromptResource`: optional appended prompt; the default follows the Harness preset.
3. `SubagentOrchestrationResource`: subagent roster, models, MCP, Skills, and guidance.

These resources resolve into a `ResolvedOrchestrationSnapshot` when a session is created or switched. Running sessions use the snapshot so later template edits do not silently change active work.

Built-in templates include Explore, Architect, Coder, Reviewer, and Tester. They are templates, not a forced pipeline. The lead agent delegates according to agent descriptions, and subagents cannot recursively spawn more subagents.

| Mode | Purpose | Behavior |
| --- | --- | --- |
| Agent | Default implementation | Edits allowed; the agent may ask or delegate |
| Plan | Plan before execution | Native planning plus plan approval |
| Ask | Read-only Q&A | Write tools restricted; never inferred from wording |

## 5. Providers and protocol gateway

Provider and agent routes support:

- `anthropic` -> Anthropic Messages
- `openai_responses` -> OpenAI Responses
- `openai_chat_completions` -> OpenAI Chat Completions

The embedded gateway exposes Responses / Messages surfaces to the runtime and routes or converts them to the selected upstream. Chat Completions is a supported upstream protocol, not a separately promised third public gateway surface.

Agent-level protocol settings override provider defaults. `requestPath` is a service prefix such as `/anthropic`, not a complete endpoint. Incompatible protocol/path combinations fail explicitly. The lead agent and every subagent may use a different provider and model. Local servers such as llama.cpp work through compatible Chat Completions endpoints.

## 6. Session isolation, MCP, and Skills

Every thread stores an independent runtime configuration including enabled MCP servers, Skills, built-in integrations, and an orchestration snapshot. Project Skills are discovered from `.claude/skills`, `.agents/skills`, `.codex/skills`, and `.pi/skills`. User Skills are included only when explicitly selected and compatible with the Core.

MCP servers are registered globally and enabled per session or agent template, with optional tool allowlists. This isolation describes Mori's configuration and injection boundary; it is not an operating-system sandbox for third-party MCP processes.

For Codex, the MCP transport descriptor (`url` / `http_headers`, or `command` / `env`) is part of the thread config and is sent through `thread/start` / `thread/resume`. `CODEX_HOME/config.toml` keeps no `[mcp_servers.*]` entries. A new thread therefore never restarts the shared app-server or waits for every other thread to go idle, so independent threads can load concurrently. Each thread carries only its own Mori MCP Hub descriptor and bearer token, and the Hub filters the visible tools per session. Loaded threads cannot change thread config in place; a descriptor change (for example toggling creative drawing or speech generation, which changes the tool timeout) takes effect only after every turn is idle and the app-server restarts.

## 7. Context management

Context control has three layers, aligned with Codex semantics but implemented per Harness:

### 7.1 Tool-output history pruning (Codex TruncationPolicy)

- **Default limit**: about `10_000` tokens, with a ×`1.2` serialization budget (same as Codex `ContextManager::record_items`).
- **Shape**: middle-truncate plus a `Warning: truncated output…` header (`codex-output-truncation` in `@eco/runtime`).
- **Claude Harness**: a `PostToolUse` hook rewrites oversized results via `updatedToolOutput` before they enter the SDK transcript / model context.
- **Bridge defense**: upstream Anthropic `tool_result` blocks (and Responses `function_call_output`) are pruned again for old sessions and non-hook paths.
- **UI previews** (for example Bash 8k-character previews) are separate from model-history pruning and do not share the same budget.

### 7.2 Semantic compaction (owned by each Harness)

Mori **does not run semantic compact**. Each Harness uses its own local auto-compaction. Mori only projects occupancy and compact events, and blocks upstream cloud compact APIs that custom models do not implement.

| Harness | Auto-compact | Mori's role |
|---|---|---|
| Claude | Agent SDK `autoCompactEnabled` + `autoCompactWindow=min(model, global)`: in-process summary + `compact_boundary`, same session | Enable the flag and write the effective window; `[1m]` aliases also follow the effective window; strip `compact_20260112`; Bridge does not forward `/v1/responses/compact` |
| Codex | app-server local compact (custom provider name, not remote `/responses/compact`) | Catalog `context_window` already mins the global cap; project `contextCompaction`; Gateway translates summary requests to third-party models |
| PI | SDK native `compaction.enabled`; trigger is `contextTokens > contextWindow - reserveTokens` | `Model.contextWindow = min(model, global)`; does not install `pi-smart-compact` |

The manual compact control is removed. The occupancy meter displays Harness-reported occupied/limit; Mori no longer schedules compaction at an 85% threshold.

### 7.3 Upstream compact shields

- **Anthropic cloud compact**: strip `compact_20260112` / `compaction` edits from `context_management` before the request is sent.
- **Responses remote compact**: Mori Bridge intercepts `POST /v1/responses/compact`, returns a non-fatal stub, and does not forward to Gateway/upstream. Codex defaults to local compact and does not depend on that endpoint.

**Tool-history truncation** (§7.1) stays separate from semantic compact and is still applied by Mori TruncationPolicy / PostToolUse.

Claude Agent SDK wiring (single-message streaming prompt, Query teardown, reserved `streamInput`) is documented in [claude-core-baseline.md](./claude-core-baseline.md).

## 8. Usage, cost, and cache

The ledger records provider, model, agent, input/output tokens, cache reads/writes, reported cost, and cost calculated from configured pricing. The unorchestrated comparison prices relevant work at the lead-model rate; it is an estimate, not an invoice or a quality-equivalence claim.

Default cache-break detection requires at least 8,000 billed prompt tokens, a previous hit rate of at least 35%, a drop of at least 25 percentage points, and unexplained cache-read loss of at least 15% of the current prompt. The UI also warns after 30 minutes of inactivity. These signals expose anomalies but cannot identify whether expiration, prefix changes, a relay, or the upstream caused them.

## 9. Vision, image generation, and ASR

- A dedicated vision model may be selected; otherwise vision follows the lead model.
- Creative Drawing supports multiple provider profiles and requires confirmation per tool invocation.
- ASR supports compatible `audio/transcriptions` and Chat Completions APIs.
- Mobile records audio while the paired Desktop owns recognition configuration and requests, avoiding duplicate provider secrets on the phone.

## 10. Supabase Center and Mobile

Users deploy their own Supabase project (see [supabase-deploy.md](supabase-deploy.md) for Cloud or [supabase-self-host.md](supabase-self-host.md) for Docker self-host). Postgres holds profiles, devices, bindings, pairing, and audit metadata; Auth owns accounts; Realtime carries presence and `eco:bind:*` RPC; Edge Functions handle secret hashing. Mori does **not** operate an official hosted node.

```mermaid
sequenceDiagram
    participant Mobile
    participant SB as Supabase
    participant Desktop
    Mobile->>SB: Auth sign-in / register device
    Desktop->>SB: Create pairing session
    Mobile->>SB: Scan QR or enter code
    SB-->>Desktop: Establish binding
    Mobile->>SB: Realtime eco.invoke
    SB->>Desktop: Broadcast deliver
    Desktop-->>SB: eco.event
    SB-->>Mobile: Stream event
```

Supabase handles identity and routing only. Files, model calls, Git, and terminals remain on Desktop. Full event payloads are not stored in the cloud; only optional audit metadata may be.

## 11. Storage and security boundaries

- SQLite stores conversations, events, usage, configuration, and compaction archives.
- Sensitive values such as API keys use system secure storage / Keychain when available; cloud sync stores ciphertext only.
- The Renderer does not receive raw secret values directly.
- MCP, terminal, browser, writes, and image generation follow their approval and tool policies.
- Clients configure only Supabase Project URL + anon key; never ship `service_role`.
- Signing certificates, App Store Connect keys, production `.env` files, and real API keys must never enter the repository.

## 12. Build and release

The repository is a Bun workspace:

```bash
bun install
bun run dev
bun run build
bun run test
bun run typecheck
bun run lint
```

Tags matching `v*` trigger validation and parallel macOS arm64, macOS x64, Windows x64, and Linux x64 builds. The publish job assembles assets, merges macOS metadata, validates the manifest, and generates `SHA256SUMS`. Beta tags must originate from `beta`; stable tags must originate from `main`.

The current macOS Beta is unsigned and uses manual updates. Windows and Linux generate automatic-update metadata.

## 13. Known limitations

- No public reproducible benchmark currently validates the proposed 65% savings figure.
- macOS artifacts are not yet signed or notarized.
- Mobile has not been publicly released.
- Supabase Center is user-owned; Realtime delivery and timeouts are handled on clients.
- Protocol conversion covers common text, tool, and streaming paths; provider-specific extensions need explicit compatibility work.
- Cache-break alerts cannot establish provider intent or root cause.

## 14. Further reading

- [User Guide](USER_GUIDE.en.md)
- [Supabase deploy (Cloud)](supabase-deploy.md)
- [Supabase self-host](supabase-self-host.md)
- [Mobile README](../apps/mobile/README.md)
- [Gateway README](../apps/gateway/README.md)
