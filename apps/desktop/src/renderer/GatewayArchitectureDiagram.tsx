import { useTranslation } from "react-i18next";
import type { UpstreamAgentCore } from "../shared/ipc";

/**
 * Gateway architecture diagram.
 *
 * Facts mirrored here come from the runtime wiring, not from marketing copy:
 *   - Codex / Claude Code / PI all point their base URL at the in-process Eco SDK Bridge
 *     (`eco-gateway-lifecycle.ts` → `startEcoSdkBridge("127.0.0.1", 18765)`).
 *   - The bridge dispatches straight into the embedded gateway, so agent → gateway never
 *     leaves the machine and never passes through the outbound proxy.
 *   - The gateway exposes three inbound protocol endpoints (`/v1/responses`,
 *     `/v1/messages`, `/v1/chat/completions`) and converts to the provider's upstream kind.
 *   - The outbound proxy lives in the gateway → upstream leg (`gateway.setUpstreamProxyUrl`,
 *     plus per-provider / per-subscription overrides), together with the User-Agent override.
 */
export interface AgentCoreNode {
  readonly core: UpstreamAgentCore;
  readonly name: string;
  readonly icon: string;
  readonly protocol: string;
}

/** Single source of truth for the three agent cores (diagram + settings fields). */
export const AGENT_CORE_META: Record<UpstreamAgentCore, Omit<AgentCoreNode, "core">> = {
  codex: { name: "Codex", icon: "./agent-icons/codex.ico", protocol: "/v1/responses" },
  claude: {
    name: "Claude Code",
    icon: "./agent-icons/claude-code.ico",
    protocol: "/v1/messages",
  },
  pi: { name: "PI", icon: "./agent-icons/pi.svg", protocol: "/v1/messages" },
};

/** Diagram order: PI, Codex, Claude Code. */
export const AGENT_CORE_NODES: readonly AgentCoreNode[] = (["pi", "codex", "claude"] as const).map(
  (core) => ({ core, ...AGENT_CORE_META[core] }),
);

const GATEWAY_PROTOCOLS = ["/v1/responses", "/v1/messages", "/v1/chat/completions"] as const;

const UPSTREAM_PROTOCOLS = ["Anthropic Messages", "OpenAI Responses", "Chat Completions"] as const;

export function GatewayArchitectureDiagram() {
  const { t } = useTranslation();

  return (
    <figure className="gateway-arch">
      <div className="gateway-arch-agents">
        {AGENT_CORE_NODES.map((node) => (
          <div className="gateway-arch-agent" key={node.core}>
            <img className="gateway-arch-agent-icon" src={node.icon} alt="" aria-hidden="true" />
            <span className="gateway-arch-agent-name">{node.name}</span>
            <code className="gateway-arch-agent-protocol">{node.protocol}</code>
          </div>
        ))}
      </div>

      <svg className="gateway-arch-converge" viewBox="0 0 300 46" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          {/* 竖线 x 与三列（1fr + 10px gap）的列中心对齐：48 / 150 / 252 */}
          <path d="M48 0V24" />
          <path d="M150 0V24" />
          <path d="M252 0V24" />
          <path d="M48 24H252" />
          <path d="M150 24V38" />
        </g>
        <path d="M150 46l-4.5-8h9z" fill="currentColor" />
      </svg>

      <div className="gateway-arch-core">
        <div className="gateway-arch-core-head">
          <span className="gateway-arch-core-title">{t("settings.gateway.arch.core")}</span>
          <code className="gateway-arch-core-address">127.0.0.1:18765</code>
        </div>
        <span className="gateway-arch-core-label">{t("settings.gateway.arch.protocols")}</span>
        <ul className="gateway-arch-core-protocols">
          {GATEWAY_PROTOCOLS.map((protocol) => (
            <li key={protocol}>
              <code>{protocol}</code>
            </li>
          ))}
        </ul>
        <div className="gateway-arch-core-credential">
          <span className="gateway-arch-core-credential-label">{t("settings.gateway.arch.credentials")}</span>
          <span className="gateway-arch-core-credential-value">
            {t("settings.gateway.arch.credentialsValue")}
          </span>
        </div>
      </div>

      <div className="gateway-arch-outbound">
        <span className="gateway-arch-outbound-chip">
          <span className="gateway-arch-outbound-title">{t("settings.gateway.arch.outbound")}</span>
          <span className="gateway-arch-outbound-hint">{t("settings.gateway.arch.outboundHint")}</span>
        </span>
      </div>

      <div className="gateway-arch-upstream">
        <span className="gateway-arch-upstream-title">{t("settings.gateway.arch.upstream")}</span>
        <ul className="gateway-arch-upstream-list">
          {UPSTREAM_PROTOCOLS.map((protocol) => (
            <li key={protocol}>{protocol}</li>
          ))}
        </ul>
        <span className="gateway-arch-upstream-hint">{t("settings.gateway.arch.upstreamHint")}</span>
      </div>

      <figcaption className="gateway-arch-notes">
        <ul>
          <li>{t("settings.gateway.arch.noteLoopback")}</li>
          <li>{t("settings.gateway.arch.noteProtocol")}</li>
          <li>{t("settings.gateway.arch.noteCredentials")}</li>
        </ul>
      </figcaption>
    </figure>
  );
}
