# Mori User Guide

[简体中文](USER_GUIDE.md) · **English** · [README](../README.en.md) · [Technical Documentation](TECHNICAL.en.md)

This guide applies to the current Beta. UI labels may evolve, but the configuration order and concepts remain stable.

## 1. Install Desktop

Download the matching artifact from [GitHub Releases](https://github.com/plus1998/Mori/releases):

| Platform | File |
| --- | --- |
| macOS 13+ Apple Silicon | `Mori-*-mac-arm64.dmg` |
| macOS 13+ Intel | `Mori-*-mac-x64.dmg` |
| Windows 10/11 x64 | `Mori-*-win-x64.exe` |
| Linux x64 | `Mori-*-linux-x64.AppImage` |

### macOS Beta

The current Beta is not signed or notarized. Move the app to Applications, Control-click it in Finder, choose Open, and confirm. Do not disable system security or run unknown `xattr` commands.

### Windows

Run the NSIS installer and choose an install directory. If SmartScreen reports an unknown publisher, verify the source and compare the download with `SHA256SUMS`. Commercial code signing is not enabled yet.

### Linux

```bash
chmod +x Mori-*-linux-x64.AppImage
./Mori-*-linux-x64.AppImage
```

Some distributions require FUSE. See the [AppImage FUSE documentation](https://github.com/AppImage/AppImageKit/wiki/FUSE).

## 2. First launch

Recommended setup order:

1. Add a local project directory.
2. Add a provider under Settings -> Model Providers.
3. Add at least one candidate model and run the connection test.
4. Create a lead config, optional prompt, and subagent orchestration under Runtime Configuration.
5. Select Codex or Claude Code as the default Harness for new sessions.
6. Return to the project, create a session, and choose Agent, Plan, or Ask.

API keys use system secure storage. If secure storage is unavailable, Mori reports the limitation instead of pretending the key was stored securely.

## 3. Configure providers

Open Settings -> Model Providers -> Add Provider and configure:

- Display name
- Base URL
- API key
- API compatibility: Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions
- Candidate model IDs

| Upstream | Compatibility | Example base URL |
| --- | --- | --- |
| Anthropic or Messages-compatible | Anthropic Messages | `https://api.anthropic.com` |
| OpenAI Responses | OpenAI Responses | `https://api.openai.com` |
| DeepSeek/Kimi/local OpenAI-compatible | Chat Completions | Provider API root |
| llama.cpp | Chat Completions | For example `http://127.0.0.1:8080` |

Do not duplicate full `/v1/messages`, `/v1/responses`, or `/v1/chat/completions` endpoints in Base URL. Use request path only when the provider requires an additional prefix.

Run a connection test after saving. A successful test confirms the selected address, protocol, key, and model can complete the test request; it does not prove support for every tool, vision, or long-context feature.

## 4. Choose a Harness

- **Codex** uses the OpenAI Codex runtime.
- **Claude Code** uses the Claude Agent SDK / Claude Code runtime.
- **PI** uses [earendil-works/pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). supports Agent / Plan / Ask with built-in read/write/edit/bash (Ask/Plan bash is limited to a read-only allowlist); Mori injects Skills and MCP per session (`.agents/skills` / `.pi/skills` plus thread-private `pi-agent/<threadId>/skills`; Composer-selected MCP / browser / image integrations injected per session through the official MCP extension (tools are named `mcp__<server>__<tool>`, e.g. the Hub's `mcp__eco_mcp__search_tools` / `mcp__eco_mcp__call_tool`), withheld during Ask/Plan planning; Settings → Personalization global rules append to the parent system prompt); session JSONL is stored under `userData/pi-agent/<threadId>/sessions/` (survives app restart; MCP server-set changes rebuild the in-process AgentSession but resume the same JSONL; model-route/thinking-effort changes start a fresh session). Lead and subagent thinking effort is passed to PI (`off` disables thinking; `low`–`max` map to PI thinkingLevel); Agent mode can delegate Mori subagents from the thread orchestration snapshot; tool approvals are Mori-bridged (BashApproval); Plan submits via `finalize_plan` → pending plan, async user approval, then a new Agent turn (quit keeps pending plans). **Mobile has not verified PI-thread tool/plan approvals.**

Mid-turn steer: follow-ups sent while a PI session is running are injected into the current turn via `AgentSession.steer()` (delivered before the next model call). When the session is idle or the run ends right as delivery lands, the message stays queued and is sent as a fresh turn after the run — Mori never pretends it was injected.

Set a default for new sessions or choose per session. Switching Harness changes native tools, approvals, and resume semantics. Existing running sessions do not switch when the global default changes.

## 5. Build an Agent Team

A runtime setup contains:

### Lead configuration

Choose the provider, model, reasoning effort, tools, and Skills. The lead agent communicates with the user, owns intent and acceptance, and decides whether to delegate.

### Lead prompt

Following the Harness's built-in prompt is the recommended default. Add a custom prompt only for team-specific behavior. Repository coding rules belong in project files such as `AGENTS.md` or `CLAUDE.md`.

### Subagent orchestration

Add templates to the roster, then configure each role's provider, model, enabled state, file/tool policy, MCP servers, Skills, and optional custom instructions.

| Role | Useful model characteristics |
| --- | --- |
| Explore | Fast, inexpensive, strong long-context reading |
| Architect | Stable reasoning across modules |
| Coder | Strong coding and reliable tool use |
| Reviewer | Conservative judgment and defect sensitivity |
| Tester | Fast command execution and acceptance discipline |

Model names are entirely user/provider configuration. Mori does not bundle or guarantee any specific commercial model.

A practical starting point is a quality-first lead, low-latency Explore and Tester roles, and risk-adjusted Coder and Reviewer models. Tune from observed quality and usage rather than price alone.

## 6. Session modes and options

- **Agent:** implementation and editing; may ask questions and delegate.
- **Plan:** native planning followed by Mori plan approval and continuation.
- **Ask:** explicit read-only explanation and analysis.

The Composer can select Harness, runtime configuration, lead and vision models, MCP servers, Skills, browser/image integrations, Bash Review, and planning behavior for the current session. These choices are stored with the session instead of being injected into every project.

## 7. MCP and Skills

### MCP

Add an MCP server under Settings -> Connectors, configure its transport, command/address, arguments, and environment, then run the connection check. Enable it in the target Composer session or agent template and set a tool allowlist when necessary.

Keep credentials in MCP environment or secure configuration, not public prompts.

### Skills

Mori discovers project Skills from:

```text
.claude/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
.codex/skills/<name>/SKILL.md
.pi/skills/<name>/SKILL.md
```

Compatible Skills can also be browsed and installed from the Skills UI. Project Skills belong to the current project; personal Skills require explicit selection. Harness-specific readiness and required links are shown in the UI.

PI Harness also loads session-private skills from `pi-agent/<threadId>/skills` and user-level `~/.pi/agent/skills`. Session transcripts live under the same thread tree at `pi-agent/<threadId>/sessions/` and can be metered/cleared in Settings → Storage; **All PI sessions** deletes those Mori chats from the sidebar, not only the on-disk files. Session toggles control injection visibility only; skill files in a shared workspace may still be readable via `read`/`bash` — this is not OS-level isolation.

## 8. Vision, image generation, and ASR

Select a dedicated vision model in runtime configuration, or let it follow the lead model. The upstream must actually accept image input.

For image generation, add and activate a provider profile under Settings -> Integrations -> Image Generation, then enable the tool for the target session. Every invocation requires confirmation and generated files are recorded locally.

Desktop ASR supports compatible `audio/transcriptions` and Chat Completions APIs. Mobile records audio while its paired Desktop owns the profile and recognition request. Mobile reports explicit offline or missing-configuration errors.

## 9. Cost and cache

After input, output, cache-read, and cache-write pricing is configured for candidate models, the usage panel shows actual tokens and cost, agent/model/event breakdowns, cache hit rate, and the comparison with an unorchestrated lead-model estimate.

Token usage may still appear when pricing is missing, but cost will be incomplete. After 30 minutes of inactivity, the Composer warns that prompt cache may have expired. Significant unexplained cache-read drops are recorded in the activity feed; diagnose them using timing, prompts, tool lists, routing, and multiple observations.

## 10. Supabase and Mobile

Mobile is not publicly released yet. Interop requires a user-owned Supabase project (no official Mori node).

### Artifacts

After Center is connected and the html-host functions are deployed, the agent can publish single-file HTML pages (progress, reports, and similar). Preview and copy the link from Feed and workspace Cards. Capability status and notes live under **Settings → Connection → Artifacts**. Without a Custom Domain on Cloud, share links may not render correctly (the Artifacts tab warns about this); see [supabase-deploy.md](supabase-deploy.md) “HTML hosting”. Mobile Feed is **not yet aligned** with this card.

### Deploy Supabase Center

- Cloud: [supabase-deploy.md](supabase-deploy.md)
- Self-host Docker: [supabase-self-host.md](supabase-self-host.md)
- Volcengine Supabase (experimental manual deploy): [supabase-volcengine.md](supabase-volcengine.md)

Cloud summary:

```bash
npx supabase login
bun run supabase:deploy -- --platform cloud --project-ref <your-project-ref>
# or: bun run supabase:deploy   # interactive wizard
```

Self-host summary: after the official Docker stack is up, from the Mori repo root:

```bash
bun run supabase:deploy -- --platform self-host --compose-dir <supabase-project-path>
```

Enable Email Auth in the Dashboard/Studio; disable open Realtime public access. Enter **Project URL** and **anon key** in Desktop / Mobile (never `service_role`).

Pairing flow:

1. Point Desktop and Mobile at the same Supabase project (URL + anon).
2. Sign in and register both devices.
3. Create a pairing session on Desktop.
4. Scan the QR code or enter the code on Mobile.
5. Use Mobile to view sessions, send messages, and handle approvals.

Execution always remains on Desktop. Mobile cannot continue agent work while the paired Desktop is offline.

Mobile development:

```bash
cd apps/mobile
flutter pub get
flutter run --flavor dev
flutter test
```

Physical iOS development requires signing for `com.plus.ecoding.dev`.

## 11. Updates

- Windows / Linux release metadata supports in-app check, download, and restart installation.
- The current unsigned macOS Beta directs users to GitHub Releases for manual download.
- Beta update policy does not silently downgrade to an older stable channel.

Commit or back up important workspace changes before updating, and do not force-quit while an agent is running.

## 12. Develop from source

Use the CI-tested Bun `1.4.0` and Node.js `22.14.0` when possible; Git is also required. Native `node-pty` builds require Xcode Command Line Tools on macOS; Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows SDK on Windows; or Python 3 plus a C/C++ toolchain and Electron system libraries on Linux.

```bash
git clone https://github.com/plus1998/Mori.git
cd Mori
bun install
bun run dev
```

Verification and packaging:

```bash
bun run build
bun run test
bun run typecheck
bun run lint
bun run pack
```

## 13. Troubleshooting

### Provider test returns 404

Remove duplicated endpoint suffixes from Base URL and verify API compatibility matches the provider.

### Chat works but vision or tools fail

Protocol compatibility does not imply capability compatibility. Verify actual image input, tool use, streaming, and context support.

### Windows source install cannot find Visual Studio

Install Visual Studio 2022 Build Tools with Desktop development with C++ and Windows SDK. Mori CI uses Node.js `22.14.0` and `@electron/rebuild` for `node-pty`.

### Linux AppImage does not launch

Set executable permission and install the distribution's FUSE compatibility package.

### Cost is zero or missing

Configure pricing for the actual routed model ID and confirm the provider returns usage data.

### Mobile says Desktop is offline

Confirm both devices use the same Supabase project, the binding is active, and Realtime is reachable.

## 14. Getting help

An actionable Issue includes the Mori version, operating system, Harness, provider protocol, redacted model ID, reproduction steps, relevant errors, and whether a fresh session/minimal project reproduces the problem.

Never submit API keys, access tokens, private source code, or a full database containing personal data.
