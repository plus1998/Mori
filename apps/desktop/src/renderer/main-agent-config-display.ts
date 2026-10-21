import {
  CHATGPT_SUBSCRIPTION_MAIN_AGENT_CONFIG_ID,
  OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID,
} from "../shared/agent-orchestration";
import { i18n } from "./i18n";

export function localizeMainAgentConfigName(configId: string, name: string): string {
  if (configId === OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID) {
    return i18n.t("settings.openaiAccounts.codexAuthAgent");
  }
  if (configId === CHATGPT_SUBSCRIPTION_MAIN_AGENT_CONFIG_ID) {
    return i18n.t("settings.models.authChatGPTSubscription");
  }
  return name.trim();
}
