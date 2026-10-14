import { type ReactNode, Suspense, lazy } from "react";

/**
 * Heavy App surfaces — loaded on first open so the main renderer chunk stays lean.
 * Keep hooks used at App root (e.g. useAsrRecorder) eager; only defer mount-gated panels.
 */

export const LazySchedulingPanel = lazy(() => import("./SchedulingPanel").then(m => ({ default: m.SchedulingPanel })));
export const LazyScheduledMessageDialog = lazy(() => import("./ScheduledMessageDialog").then(m => ({ default: m.ScheduledMessageDialog })));

export const LazyActivityLogView = lazy(() =>
  import("./ActivityLogView").then((m) => ({ default: m.ActivityLogView })),
);

export const LazyAsrSettingsPanel = lazy(() =>
  import("./AsrSettingsPanel").then((m) => ({ default: m.AsrSettingsPanel })),
);

export const LazyBrowserSettingsPanel = lazy(() =>
  import("./BrowserSettingsPanel").then((m) => ({ default: m.BrowserSettingsPanel })),
);

export const LazyBrowserWebviewLayer = lazy(() =>
  import("./BrowserWebviewLayer").then((m) => ({ default: m.BrowserWebviewLayer })),
);

export const LazyCenterServerSettingsPanel = lazy(() =>
  import("./CenterServerSettingsPanel").then((m) => ({ default: m.CenterServerSettingsPanel })),
);

export const LazyComputerUseSettingsPanel = lazy(() =>
  import("./ComputerUseSettingsPanel").then((m) => ({ default: m.ComputerUseSettingsPanel })),
);

export const LazyContextWindowSettingsPanel = lazy(() =>
  import("./ContextWindowSettingsPanel").then((m) => ({ default: m.ContextWindowSettingsPanel })),
);

export const LazyDefaultAgentSettingsPanel = lazy(() =>
  import("./DefaultAgentSettingsPanel").then((m) => ({ default: m.DefaultAgentSettingsPanel })),
);

export const LazyGeneralSettingsPanel = lazy(() =>
  import("./GeneralSettingsPanel").then((m) => ({ default: m.GeneralSettingsPanel })),
);

export const LazyGitSettingsPanel = lazy(() =>
  import("./GitSettingsPanel").then((m) => ({ default: m.GitSettingsPanel })),
);

export const LazyImageGalleryFloat = lazy(() =>
  import("./ImageGalleryFloat").then((m) => ({ default: m.ImageGalleryFloat })),
);

export const LazyImageGenerationSettingsPanel = lazy(() =>
  import("./ImageGenerationSettingsPanel").then((m) => ({ default: m.ImageGenerationSettingsPanel })),
);

export const LazyIntegratedWebSearchSettingsPanel = lazy(() =>
  import("./IntegratedWebSearchSettingsPanel").then((m) => ({
    default: m.IntegratedWebSearchSettingsPanel,
  })),
);

export const LazyMcpSettingsPanel = lazy(() =>
  import("./McpSettingsPanel").then((m) => ({ default: m.McpSettingsPanel })),
);

export const LazyModelsSettingsPanel = lazy(() =>
  import("./ModelsSettingsPanel").then((m) => ({ default: m.ModelsSettingsPanel })),
);

export const LazyOpenAIAccountsPanel = lazy(() =>
  import("./components/OpenAIAccountsPanel").then((m) => ({ default: m.OpenAIAccountsPanel })),
);

export const LazyNotificationPreferencesPanel = lazy(() =>
  import("./NotificationPreferencesPanel").then((m) => ({ default: m.NotificationPreferencesPanel })),
);

export const LazyPersonalizationSettingsPanel = lazy(() =>
  import("./PersonalizationSettingsPanel").then((m) => ({ default: m.PersonalizationSettingsPanel })),
);

export const LazyProxySettingsPanel = lazy(() =>
  import("./ProxySettingsPanel").then((m) => ({ default: m.ProxySettingsPanel })),
);

export const LazySkillsSettingsPanel = lazy(() =>
  import("./SkillsSettingsPanel").then((m) => ({ default: m.SkillsSettingsPanel })),
);

export const LazyStorageSettingsPanel = lazy(() =>
  import("./StorageSettingsPanel").then((m) => ({ default: m.StorageSettingsPanel })),
);

export const LazySubagentTaskDrawer = lazy(() =>
  import("./SubagentTaskDrawer").then((m) => ({ default: m.SubagentTaskDrawer })),
);

export const LazyTerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

/** Minimal placeholder while a settings/terminal/task chunk loads. */
export function PanelChunkFallback(): ReactNode {
  return <div className="panel-chunk-fallback" aria-busy="true" />;
}

export function SuspensePanel({ children }: { children: ReactNode }): ReactNode {
  return <Suspense fallback={<PanelChunkFallback />}>{children}</Suspense>;
}

export const LazyTtsSettingsPanel = lazy(() => import("./TtsSettingsPanel").then(m => ({ default: m.TtsSettingsPanel })));
