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
const readOnly = new URLSearchParams(location.search).has("readOnly");
const never = () => new Promise<never>(() => {});
const catalog = (modelId: string): CodexModelCatalogSnapshot => ({
  models: [{ modelId, displayName: modelId, hidden: false, origin: "remote", reasoningEfforts: ["low", "high"],
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
      return [{ accountId: "oauth-account", displayName: "Local OAuth account", enabled: true, hasCredentials: true }];
    },
    async getCodexModelCatalog() {
      return holdCatalogs ? never() : catalog("Login local model");
    },
    async getChatGptModelCatalog() {
      if (pending === "oauth-models") return new Promise((_resolve, reject) => { rejectOauthCatalog = reject; });
      return holdCatalogs ? never() : catalog("OAuth local model");
    },
    async chatGptSubscriptionAccountModelsList() {
      remoteModelReads += 1;
      return never();
    },
    async openAIAccountsQueryQuota() { return never(); },
  },
  pickerRemoteModelReads: () => remoteModelReads,
  pickerSelections: () => selections,
  pickerLastSelection: () => lastSelection,
});

await i18n.changeLanguage("en-US");
document.documentElement.dataset.theme = "light";
function Fixture() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState<ModelRef>({ providerId: "openai", modelId: "Login local model", accountId: "login-account" });
  return <>
    <div ref={anchorRef} style={{ position: "fixed", bottom: 20, left: 20, width: 900 }}>
      <ComposerMainModelPicker anchorRef={anchorRef} coreKind="codex"
        model={model}
        readOnly={readOnly}
        onSelect={(choice) => { selections += 1; lastSelection = choice; setModel(choice); }} onAddProvider={() => {}} />
    </div>
    {new URLSearchParams(location.search).has("acp") ? <ComposerAcpModelTrigger
      models={[{ id: "gpt-test", displayName: "GPT test" }]}
      selectedModelId="gpt-test" readOnly={readOnly} onChange={() => { selections += 1; }} /> : null}
    <button type="button" onClick={() => rejectOauthCatalog?.(new Error("OAuth catalog read failed"))}>
      Fail OAuth catalog
    </button>
    <button type="button" onClick={() => { holdCatalogs = true; }}>Hold catalog reads</button>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
