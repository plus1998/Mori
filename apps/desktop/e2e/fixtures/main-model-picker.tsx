import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerAcpModelTrigger } from "../../src/renderer/ComposerAcpModelTrigger";
import { ComposerMainModelPicker } from "../../src/renderer/ComposerMainModelPicker";
import { i18n } from "../../src/renderer/i18n";
import type { CodexModelCatalogSnapshot } from "../../src/shared/models";
import type { ModelRef } from "../../src/shared/agent-orchestration";
import "../../src/renderer/styles.css";
import "../../src/renderer/themes.css";

const pending = new URLSearchParams(location.search).get("pending");
let rejectOauthCatalog: ((error: Error) => void) | undefined;
let holdCatalogs = false;
let remoteModelReads = 0;
let selections = 0;
let lastSelection: ModelRef | undefined;
let loginModelId = "Login local model";
let finishLoginRefresh: ((error?: Error) => void) | undefined;
const readOnly = new URLSearchParams(location.search).has("readOnly");
const never = () => new Promise<never>(() => {});
const catalog = (modelId: string): CodexModelCatalogSnapshot => ({
  models: [{ modelId, displayName: modelId, hidden: false, origin: "remote", reasoningEfforts: new URLSearchParams(location.search).has("fullEfforts")
    ? ["off", "low", "medium", "high", "xhigh", "max"] : ["low", "high"],
    supportsFast: !new URLSearchParams(location.search).has("noFast") }],
  status: { sourceUrl: "local-test", remoteCount: 1, manualCount: 0 },
});

// Deliberately pending dependencies verify that local catalogs render independently.
// Every API is local to this fixture; no SDK, quota service or model endpoint runs.
Object.assign(window, {
  eco: {
    async listGitCommitModelOptions() {
      if (pending === "custom") return never();
      if (new URLSearchParams(location.search).has("custom")) return {
        options: [{ providerId: "custom-provider", providerName: "Custom provider",
          modelId: "Login local model", modelLabel: "Custom local model", candidateModelId: "custom-model" }],
        savedCandidateModelId: "auto",
      };
      return { options: [], savedCandidateModelId: "auto" };
    },
    async listCandidateModels() { return [{ id: "custom-model", resolvedSupportsReasoning: true }]; },
    async openAIAccountsList() {
      return [{ id: "login-account", name: "Local Login account", isLoggedIn: true }];
    },
    async chatGptSubscriptionAccountsList() {
      if (pending === "oauth-accounts") return never();
      return [{ accountId: "oauth-account", displayName: "Local OAuth account", enabled: true, hasCredentials: true, status: "ready" }];
    },
    async getCodexModelCatalog() {
      return holdCatalogs ? never() : catalog(loginModelId);
    },
    async refreshCodexModelCatalog() {
      return new Promise<CodexModelCatalogSnapshot>((resolve, reject) => {
        finishLoginRefresh = (error) => {
          if (error) {
            reject(error);
            return;
          }
          loginModelId = "Login refreshed model";
          resolve(catalog(loginModelId));
        };
      });
    },
    async getChatGptModelCatalog() {
      return holdCatalogs ? never() : catalog("OAuth local model");
    },
    async chatGptSubscriptionAccountModelsList(accountId: string) {
      if (accountId !== "oauth-account") throw new Error("Unexpected OAuth account");
      remoteModelReads += 1;
      if (pending === "oauth-models") return new Promise((_resolve, reject) => { rejectOauthCatalog = reject; });
      const id = remoteModelReads === 1 ? "OAuth local model" : "OAuth refreshed model";
      return holdCatalogs ? never() : [{ id, displayName: id }];
    },
    async openAIAccountsQueryQuota() { return never(); },
    async openAIAccountsUltrafastModels() { return []; },
  },
  finishLoginRefresh: (fail: boolean) => finishLoginRefresh?.(fail ? new Error("Login refresh failed") : undefined),
  pickerRemoteModelReads: () => remoteModelReads,
  pickerSelections: () => selections,
  pickerLastSelection: () => lastSelection,
});

await i18n.changeLanguage("en-US");
document.documentElement.dataset.theme = "light";
function Fixture() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState<ModelRef>({ providerId: "openai", modelId: "Login local model", accountId: "login-account" });
  const [cursorModel, setCursorModel] = useState({ id: "gpt-test", displayName: "GPT test" });
  return <>
    <div ref={anchorRef} style={{ position: "fixed", bottom: 20, left: 20, width: 900 }}>
      <ComposerMainModelPicker anchorRef={anchorRef} coreKind="codex"
        model={model}
        allowModelRefresh
        readOnly={readOnly}
        onSelect={(choice) => { selections += 1; lastSelection = choice; setModel(choice); }} onAddProvider={() => {}} />
    </div>
    {new URLSearchParams(location.search).has("acp") ? <ComposerAcpModelTrigger
      anchorRef={anchorRef}
      models={[cursorModel]}
      onRefreshModels={() => setCursorModel({ id: "gpt-refreshed", displayName: "GPT refreshed" })}
      selectedModelId="gpt-test" readOnly={readOnly} onChange={() => { selections += 1; }} /> : null}
    <button type="button" onClick={() => rejectOauthCatalog?.(new Error("OAuth catalog read failed"))}>
      Fail OAuth catalog
    </button>
    <button type="button" onClick={() => { holdCatalogs = true; }}>Hold catalog reads</button>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
