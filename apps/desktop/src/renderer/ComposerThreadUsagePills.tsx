import type { AcpHostUiFeatures } from "@eco/runtime/acp-host-ui-features";
import { formatUsageBadge } from "@eco/runtime/usage";
import { useTranslation } from "react-i18next";
import type { ThreadBillingSnapshot, ThreadContextSnapshot, ThreadStatus } from "../shared/ipc";
import {
  contextCardPlaceholderKey,
  shouldShowBillingUsagePanel,
  shouldShowContextUsagePanel,
} from "../shared/thread-usage-summary";
import type { ComposerAgentModelLabel } from "./composer-agent-model-labels";
import type { RuntimeAgentDisplayNames } from "./runtime-agent-display";
import type { RuntimeAgentThemes } from "./runtime-agent-theme";
import { resolveBillingMainModelLabel, ThreadInfoFloatStack } from "./ThreadInfoPanel";
import type { ThreadUsageSummary } from "./WorkspaceFloatingCards";

function hasBillingData(billing?: ThreadBillingSnapshot): billing is ThreadBillingSnapshot {
  if (!billing) {
    return false;
  }
  const total =
    billing.totalTokens.input +
    billing.totalTokens.output +
    billing.totalTokens.cacheRead +
    billing.totalTokens.cacheCreation;
  return (
    total > 0 ||
    billing.sourceReportedCostUsd > 0 ||
    billing.plannerTokenCostUsd > 0 ||
    billing.ecoCostUsd > 0
  );
}

export interface ComposerThreadUsagePillsProps {
  threadId?: string;
  threadStatus?: ThreadStatus;
  usageSummary?: ThreadUsageSummary;
  hostUiFeatures?: AcpHostUiFeatures;
  showBilling?: boolean;
  contextCompactionInFlight?: boolean;
  autoCompactSuspended?: boolean;
  promptCacheInvalidated?: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  agentModelLabels?: ComposerAgentModelLabel[];
}

export function ComposerThreadUsagePills({
  threadId,
  threadStatus,
  usageSummary,
  hostUiFeatures,
  showBilling: showBillingPreference = true,
  contextCompactionInFlight = false,
  autoCompactSuspended = false,
  promptCacheInvalidated = false,
  agentDisplayNames,
  agentThemes,
  agentModelLabels,
}: ComposerThreadUsagePillsProps) {
  const { t } = useTranslation();
  const billing = usageSummary?.billing;
  const tokenBadge = billing
    ? formatUsageBadge({
        inputTokens: billing.totalTokens.input,
        outputTokens: billing.totalTokens.output,
        cacheReadTokens: billing.totalTokens.cacheRead,
        cacheCreationTokens: billing.totalTokens.cacheCreation,
      })
    : null;
  const plannerLabel = resolveBillingMainModelLabel(billing, agentModelLabels, "主模型");
  const showContext = shouldShowContextUsagePanel(threadStatus, hostUiFeatures);
  const showBilling = hasBillingData(billing);
  const showBillingSection =
    showBillingPreference &&
    shouldShowBillingUsagePanel(threadStatus, hostUiFeatures) &&
    (showBilling || threadStatus !== undefined);

  if (!showBillingSection && !showContext) {
    return null;
  }

  return (
    <div className="composer-footer-usage">
      <ThreadInfoFloatStack
        variant="composer"
        {...(threadId !== undefined && { threadId })}
        showBillingSection={showBillingSection}
        showContext={showContext}
        {...(hostUiFeatures !== undefined && { hostUiFeatures })}
        {...(billing !== undefined && { billing })}
        {...(usageSummary?.ledgerEvents && { ledgerEvents: usageSummary.ledgerEvents })}
        {...(threadStatus !== undefined && { threadStatus })}
        tokenBadge={tokenBadge}
        plannerLabel={plannerLabel}
        showBilling={showBilling}
        {...(usageSummary?.context !== undefined && { context: usageSummary.context })}
        contextPlaceholder={t(contextCardPlaceholderKey(threadStatus))}
        contextCompactionInFlight={contextCompactionInFlight}
        autoCompactSuspended={autoCompactSuspended}
        promptCacheInvalidated={promptCacheInvalidated}
        {...(agentDisplayNames && { agentDisplayNames })}
        {...(agentThemes && { agentThemes })}
      />
    </div>
  );
}
