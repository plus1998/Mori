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
  return {
    ...runtimeConfig,
    // Discovery and project preferences seed new threads. Existing threads keep
    // their saved Skills snapshot, including an absent or partial legacy value.
    ...(!input.hasThread && Object.keys(input.skillsEnabled).length > 0
      ? { skillsEnabled: input.skillsEnabled }
      : {}),
    ...(Object.keys(input.mcpServersEnabled).length > 0
      ? { mcpServersEnabled: input.mcpServersEnabled }
      : {}),
    integrationsEnabled: input.integrationsEnabled,
  };
}
