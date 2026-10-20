<div align="center">
  <img src="apps/desktop/public/splash-icon.png" width="112" alt="Eco Coding Logo" />
  <h1>Eco Coding</h1>
  <p>Eco Coding is an open-source desktop AI coding workspace built on leading Agent Harnesses<br/>Designed to orchestrate different models at lower cost and provide a more open, flexible development experience.</p>
  <p>
    <a href="README.md">简体中文</a> · <strong>English</strong>
  </p>
  <p>
    <a href="https://github.com/plus1998/eco-coding/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/plus1998/eco-coding?include_prereleases&style=flat-square" /></a>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" /></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2563eb?style=flat-square" />
    <img alt="Status" src="https://img.shields.io/badge/status-beta-f59e0b?style=flat-square" />
  </p>
</div>

> Currently in Beta. The desktop app is free to download. Mobile and self-hosted Supabase Center live in this repo; mobile has not been publicly released yet.

A multi-agent coding workspace for Codex, Claude Code, and PI—with model routing, subagent orchestration, cost observability, and cross-device sync.

![Eco Coding dark workspace with the project sidebar, task conversation, and Agent workspace](docs/assets/eco-product-overview-dark.jpg)

<p align="center"><sub>Each session independently configures subagents, integrations, Skills, and MCP.</sub></p>

![Eco Coding mobile: session list and remote Agent chat](docs/assets/eco-mobile-demo.png)

<p align="center"><sub>Browse Sessions on your phone, follow tasks, and keep talking with the Agent while away from the desk.</sub></p>

## Why Eco Coding

If you already use Codex or Claude Code, Eco Coding puts them in one workspace and adds what most official clients leave out:

- **Mix models** — Combine GPT, Claude, DeepSeek, Kimi, and more across Responses / Messages / Chat Completions
- **Split work, cut cost** — Lead agent plans and accepts; subagents search, code, and test in parallel on cheaper models
- **Session isolation** — MCP, Skills, and tool policies per project or session—no global context pollution
- **Dedicated vision** — Give any model its own eyes (vision) and brush (image generation)
- **Transparent billing** — Know exactly what you spent per session, plus cache hit rate
- **Mobile sync** — Open-source Flutter client: remote sessions, approvals, images, and voice input; pairs with desktop over self-hosted Supabase—no subscription
- **Fully open stack** — macOS / Windows / Linux desktop + Supabase Center, MIT License

Prefer a single model? That works too—multi-agent is optional.

## Quick start

**[Download the desktop app →](https://github.com/plus1998/eco-coding/releases)** (macOS / Windows / Linux)

Run from source (Bun `1.4.0`+ and Node.js `22.14.0`+ recommended):

```bash
git clone https://github.com/plus1998/eco-coding.git
cd eco-coding
bun install
bun run dev
```

After the first launch, add API credentials under Settings → Model Providers, then create a runtime configuration. The macOS Beta is unsigned—see the [User Guide](docs/USER_GUIDE.en.md).

## Capability overview

| Area | Capability |
| --- | --- |
| Agent Core | Codex, Claude Code, and PI; selected per session |
| Orchestration | Custom lead config, subagent roster, models, and tool policies |
| Model routing | Multiple providers; Responses / Messages / Chat Completions |
| Session modes | Agent, Plan, Ask |
| Context | Occupancy, compaction, handoff recovery |
| Cost | Tokens, cost, cache I/O, hit rate, breakdown and comparison |
| Integrations | MCP, Skills, built-in browser, image generation, vision model, ASR |
| Engineering workflow | Git diff, Worktrees, terminal, code review |
| Mobile collaboration | Device pairing, remote sessions, approvals, images, voice input |

## Supported platforms

| Platform | Architecture | Artifact | Update behavior |
| --- | --- | --- | --- |
| macOS | Apple Silicon, Intel | DMG / ZIP | Current unsigned Beta uses manual download |
| Windows 10/11 | x64 | NSIS installer | In-app updates supported |
| Linux | x64 | AppImage | In-app updates supported |

## Highlights

- **Three Agent Cores**: choose Codex, Claude Code, or PI per session; run different cores in the same project.
- **Session-scoped isolation**: enable MCP, Skills, browser, and image generation per session; auto-discover project Skills.
- **Multi-protocol gateway**: OpenAI Responses, Anthropic Messages, Chat Completions, and local compatible endpoints.
- **Dedicated vision and integrations**: separate vision models; image-generation APIs and mobile ASR.
- **Fully open stack**: Electron desktop + self-hosted Supabase Center + Flutter mobile, MIT License.

### Cross-provider Agent Teams

Bind lead and subagents independently to providers, models, protocols, MCP, and Skills; built-in Explore / Architect / Coder / Reviewer / Tester templates.

![Eco Coding dark Agent Team configuration with Explore, Coder, and Tester on MyCodex Luna](docs/assets/eco-agent-team-dark.jpg)

<p align="center"><sub>Lead and subagents can bind different providers, models, protocols, and tool policies.</sub></p>

### Observable cost and cache

Track cost and cache by session, agent, and model; compare orchestrated vs unorchestrated estimates.

![Eco Coding dark billing and prompt-cache panel](docs/assets/eco-cost-cache-dark.jpg)

<p align="center"><sub>Track cost and cache hit rate by session, agent, and model; compare orchestrated vs unorchestrated estimates.</sub></p>

## Orchestration and cost philosophy

Subagents and multi-agent setups address the division of complex work. A single high-capability model can complete complex tasks alone, but leaving it to search, implement, test, and review for long stretches makes context noisy and bills every step at the highest unit price. The lead agent can stay user-facing: understand goals, dispatch work, and own acceptance; concrete work goes to faster, cheaper, or locally running models. Subagents matter because they get independent task contexts, parallelize independent work, and let models of different cost and capability do what they fit.

This is Eco Coding's core idea. Almost every major model lab is shipping large and small models in the same family—exactly this trend. DeepSeek Flash's speed and ultra-low price, OpenCode 2's rewrite philosophy, and the recent ~80% cut in GPT Luna pricing all feel like part of the same wave. The idea took shape a few months ago; watching the field move step by step in this direction made it urgent to ship and open-source Eco Coding early.

![Eco Coding dark orchestration diagram: lead planner with parallel Explore, Coder, and Tester workers](docs/assets/eco-orchestration-future-dark.jpg)

<p align="center"><sub>Lead plans and accepts; workers run in parallel with isolated context and tiered pricing.</sub></p>

### A reusable setup

In Eco Coding, `gpt-5.6-sol` can serve as the lead agent or planner: it understands the request, breaks down the work, decides whether to delegate, and owns acceptance. Assign `gpt-5.6-luna` with `max` reasoning effort to execution roles such as Explore, Coder, and Tester. This is a working style validated in real use. On long tasks, actual cost can drop by about 60%–80%.

With custom prompts:

```
(to be filled in)
```

### Clear price gaps

| Route example | Input price | Input gap | Output price | Output gap |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.6-sol` vs `gpt-5.6-luna` | `$5.00` vs `$0.20` | Sol is about `25x` | `$30.00` vs `$1.20` | Sol is about `25x` |
| `Claude Opus 4.8` vs `DeepSeek V4 Flash` | `$5.00` vs `$0.14` | Claude is about `35.7x` | `$25.00` vs `$0.28` | Claude is about `89.3x` |

### What Eco Coding does

Eco Coding connects model aggregation with task delegation. A lead agent can use a high-capability model to maintain intent and acceptance criteria, while roles such as Explore, Coder, and Tester switch to cheaper, lower-latency, or local models; different roles may also come from different providers. Eco Coding centralizes routing, protocols, reasoning effort, context isolation, tool policies, MCP, Skills, cost, and cache observability so users can see why each model was used, what it cost, and whether the orchestration is worth repeating.

It does not prescribe one permanent model or a fixed number of agents. It provides a composable dispatch and observability layer: the same task can use one agent or parallel subagents.

A cache anomaly shows that the request prefix or upstream cache behavior changed. A single alert cannot establish a provider's intent or fault; Eco exposes the evidence and leaves the conclusion to the user.

## Documentation

- [User Guide](docs/USER_GUIDE.en.md): installation, providers, Agent Teams, MCP, Skills, mobile, and troubleshooting
- [Technical Documentation](docs/TECHNICAL.en.md): architecture, runtimes, gateway, context, billing, storage, and releases
- [Supabase deploy (Cloud)](docs/supabase-deploy.md): first-time and incremental cloud deploy
- [Supabase self-host](docs/supabase-self-host.md): Docker self-host + Eco schema/functions (human and agent runnable)
- [Volcengine Supabase (experimental)](docs/supabase-volcengine.md): manual Workspace and CLI deploy

## Repository layout

```text
apps/
  desktop/                    Electron + React desktop app
  gateway/                    Multi-protocol model gateway (local)
  mobile/                     Flutter mobile client
supabase/                     User-owned Supabase: migrations + Edge Functions
packages/
  runtime/                    Agent Cores, context, and orchestration runtime
  shared/                     Cross-client contracts and shared types
  openai-anthropic-bridge/    OpenAI / Anthropic protocol conversion
  model-router/               Model routing
  workspace/                  Workspace and Worktree workflows
```

## Project status

Eco Coding is evolving quickly. Beta releases are intended for evaluation, feedback, and development.

Current priorities:

- macOS signing and notarization
- Reproducible multi-agent quality and cost benchmarks
- Mobile release workflow
- Contribution guide, security policy, and end-to-end coverage

## License

Eco Coding is open source under the [MIT License](LICENSE). The project name, logo, and official distribution channels are not automatically licensed as trademarks by the MIT software license.
