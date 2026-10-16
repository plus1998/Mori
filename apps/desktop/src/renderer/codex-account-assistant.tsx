import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { i18n } from "./i18n";
import { OpenAIAccountAssistantApp } from "./components/OpenAIAccountAssistantApp";
import "./codex-account-assistant.css";

document.documentElement.lang = i18n.resolvedLanguage ?? "zh-CN";
createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <OpenAIAccountAssistantApp />
  </I18nextProvider>,
);
