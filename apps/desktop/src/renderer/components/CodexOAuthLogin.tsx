import { canUseOpenAIAccountCredentials } from "../../shared/openai-account";
interface CodexOAuthLoginProps {
  status: { isLoggedIn: boolean; message: string; authState?: import("../../shared/openai-account").OpenAIAccountAuthState };
  loggingIn?: boolean;
  onLoginClick?: () => void;
  onLogoutClick?: () => void;
}

export function CodexOAuthLogin({ status, loggingIn, onLoginClick, onLogoutClick }: CodexOAuthLoginProps) {
  return (
    <div className="codex-oauth-login">
      <div className="status">
        <span className={canUseOpenAIAccountCredentials(status) ? "logged-in" : "logged-out"}>
          {status.message}
        </span>
      </div>

      {!canUseOpenAIAccountCredentials(status) ? (
        <button
          onClick={onLoginClick}
          disabled={loggingIn}
          className="login-button"
        >
          {loggingIn ? "登录中..." : "登录 OpenAI 账号"}
        </button>
      ) : (
        <button
          onClick={onLogoutClick}
          className="logout-button"
        >
          退出登录
        </button>
      )}
    </div>
  );
}
