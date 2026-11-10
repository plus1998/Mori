import type { OpenAIAccountDetails, OpenAIAccountWebAuth } from "../shared/openai-account";
import { ChatGptWebSessionError, webAuthJson } from "./chatgpt-web-session";

/** Keeps Web renewal and Codex credential ownership separate, serialized per account. */
export class ChatGptWebAccountCredentials {
  constructor(private readonly deps: {
    run<T>(id: string, action: () => Promise<T>): Promise<T>;
    getAccount(id: string): Promise<OpenAIAccountDetails>;
    readSession(id: string, email?: string): Promise<OpenAIAccountWebAuth>;
    saveSession(id: string, auth: OpenAIAccountWebAuth | undefined, error?: string): Promise<void>;
    ensureCodex(id: string): Promise<void>;
  }) {}

  forImages(id: string): Promise<OpenAIAccountDetails> {
    return this.deps.run(id, async () => {
      const account = await this.deps.getAccount(id);
      if (!account.webAuth && !account.webAuthError) {
        // Existing Codex-only accounts retain their established Web image route.
        await this.deps.ensureCodex(id);
        return this.deps.getAccount(id);
      }
      if (account.webAuth && !account.webAuthError && account.webAuth.expiresAt > Date.now() + 60_000) {
        return { ...account, authJson: webAuthJson(account.webAuth) };
      }
      try {
        const auth = await this.deps.readSession(id, account.email);
        await this.deps.saveSession(id, auth);
        return { ...await this.deps.getAccount(id), authJson: webAuthJson(auth) };
      } catch (error) {
        await this.deps.saveSession(id,
          error instanceof ChatGptWebSessionError && error.reauthorizationRequired ? undefined : account.webAuth,
          error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }
}
