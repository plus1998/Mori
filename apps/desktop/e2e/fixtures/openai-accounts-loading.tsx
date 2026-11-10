import { createRoot } from "react-dom/client";
import { ModelsSettingsPanel } from "../../src/renderer/ModelsSettingsPanel";
import { i18n } from "../../src/renderer/i18n";
import type { ModelSettingsSnapshot } from "../../src/shared/ipc";
import type { OpenAIAccount } from "../../src/shared/openai-account";
import "../../src/renderer/styles.css";

let reads = 0;
const listeners = new Set<() => void>();
const pending = new Map<number, { resolve: (accounts: OpenAIAccount[]) => void; reject: (cause: Error) => void }>();
// All reads are controlled locally; this fixture never reaches SQLite or account endpoints.
Object.assign(window, {
  eco: {
    openAIAccountsList() {
      const id = ++reads;
      return new Promise<OpenAIAccount[]>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onOpenAIAccountsChanged(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCodexOauthLoginResult() { return () => {}; },
    async openAIAccountsGetWakeModel() { return null; },
    async getCodexModelCatalog() {
      return { models: [], status: { sourceUrl: "", pricingSourceUrl: "", remoteCount: 0, manualCount: 0 } };
    },
  },
  accountLoadingFixture: {
    reads: () => reads,
    listeners: () => listeners.size,
    changed: () => listeners.forEach((listener) => listener()),
    complete(id: number, name: string | null) {
      const request = pending.get(id);
      if (!request) throw new Error(`No pending read ${id}`);
      pending.delete(id);
      request.resolve(name === null ? [] : [{ id: "local-account", name, isLoggedIn: false,
        createdAt: "2026-01-01T00:00:00Z", proxyMode: "system" }]);
    },
    fail(id: number) {
      const request = pending.get(id);
      if (!request) throw new Error(`No pending read ${id}`);
      pending.delete(id);
      request.reject(new Error("SQLite account read failed"));
    },
  },
});

await i18n.changeLanguage("en-US");
document.documentElement.dataset.theme = "light";
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<ModelsSettingsPanel
  settings={{ providers: [], agentTemplates: [], mainAgentPrompts: [], subagentOrchestrations: [] } as unknown as ModelSettingsSnapshot}
  mode="providerSettings" initialTab="openaiAccounts" onSettingsChange={() => {}}
/>);
