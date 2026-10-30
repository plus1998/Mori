import { createRoot } from "react-dom/client";
import { ChatGPTSubscriptionAccountsPanel } from "../../src/renderer/ChatGPTSubscriptionAccountsPanel";
import { i18n } from "../../src/renderer/i18n";
import type { CodexModelCatalogSnapshot } from "../../src/shared/models";
import "../../src/renderer/styles.css";

const lateLoad = new URLSearchParams(location.search).has("late-load");
let rejectDelayedLoad: ((error: Error) => void) | undefined;
let reads = 0;
let refreshes = 0;
let tests = 0;
let accountReads = 0;
let account = {
  accountId: "feedback-test",
  displayName: "Offline account",
  email: "offline@example.test",
  enabled: true,
  hasCredentials: true,
  status: "not_eligible",
};
let catalog: CodexModelCatalogSnapshot = {
  models: ["first", "second"].map((id) => ({
    modelId: id,
    displayName: id,
    hidden: false,
    origin: "remote",
    reasoningEfforts: [],
  })),
  status: { sourceUrl: "", pricingSourceUrl: "", remoteCount: 2, manualCount: 0 },
};

// This browser fixture never calls account services or model endpoints.
Object.assign(window, {
  eco: {
    async chatGptSubscriptionAccountsList() {
      accountReads += 1;
      if (!lateLoad && accountReads === 2) throw new Error("account list unavailable");
      return [account];
    },
    onChatGptSubscriptionLoginResult() {
      return () => {};
    },
    async getChatGptModelCatalog() {
      reads += 1;
      if (lateLoad && reads === 2) {
        return new Promise((_resolve, reject) => {
          rejectDelayedLoad = reject;
        });
      }
      return catalog;
    },
    async refreshChatGptModelCatalog() {
      refreshes += 1;
      if (!lateLoad && refreshes === 1) {
        catalog = { ...catalog, status: { ...catalog.status, lastError: "model refresh failed" } };
        throw new Error("model refresh failed");
      }
      const status = { ...catalog.status, fetchedAt: Date.now() };
      delete status.lastError;
      catalog = { ...catalog, status };
      return catalog;
    },
    async chatGptSubscriptionAccountTest() {
      tests += 1;
      if (tests === 1) return { success: false, message: "connection failed" };
      account = { ...account, status: "ready" };
      return { success: true, message: "connection succeeded" };
    },
  },
});

await i18n.changeLanguage("en-US");
document.documentElement.dataset.theme = "light";
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <>
    <ChatGPTSubscriptionAccountsPanel />
    <button type="button" onClick={() => rejectDelayedLoad?.(new Error("delayed model failure"))}>
      Deliver delayed failure
    </button>
  </>,
);
