import type { McpServersEnabledSettings } from "../shared/composer-mcp";
import type { SkillsEnabledSettings } from "../shared/composer-skills-settings";
import type { IntegrationsEnabledSettings } from "../shared/integrations";
import type { ThreadRuntimeConfig } from "../shared/ipc";

export function buildEffectiveComposerRuntimeConfig(
  runtimeConfig: ThreadRuntimeConfig | null,
  input: {
    hasThread: boolean;
    skillsEnabled: SkillsEnabledSettings;
    mcpServersEnabled: McpServersEnabledSettings;
    integrationsEnabled: IntegrationsEnabledSettings;
  },
): ThreadRuntimeConfig | null {
  if (!runtimeConfig) return null;
  if (input.hasThread) {
    // An existing thread owns a frozen runtime snapshot. Global Composer
    // discovery and integration settings seed new threads only; importing
    // them here makes the idle Composer look different from the config that
    // the latest run accepted and can produce a false prompt-cache warning.
    return runtimeConfig;
  }
  return {
    ...runtimeConfig,
    ...(Object.keys(input.skillsEnabled).length > 0
      ? { skillsEnabled: input.skillsEnabled }
      : {}),
    ...(Object.keys(input.mcpServersEnabled).length > 0
      ? { mcpServersEnabled: input.mcpServersEnabled }
      : {}),
    integrationsEnabled: input.integrationsEnabled,
  };
}
