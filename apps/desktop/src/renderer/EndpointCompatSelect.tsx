import { API_COMPAT_THEME, type UpstreamApiCompat } from "../shared/api-compat";

const ENDPOINT_ICONS: Record<UpstreamApiCompat, string> = {
  system_one: "./provider-icons/system-one.png",
  anthropic: "./provider-icons/claude.ico",
  openai_responses: "./provider-icons/openai.svg",
  openai_chat_completions: "./provider-icons/openai.svg",
};

export interface EndpointCompatOption {
  apiCompat: UpstreamApiCompat;
  requestPath: string;
  version?: string;
}

interface EndpointCompatSelectProps {
  options: readonly EndpointCompatOption[];
  activeApiCompat: UpstreamApiCompat;
  onChange: (apiCompat: UpstreamApiCompat) => void;
  disabled?: boolean;
}

export function EndpointCompatSelect({
  options,
  activeApiCompat,
  onChange,
  disabled,
}: EndpointCompatSelectProps) {
  return (
    <div
      className="endpoint-compat-select"
      role="tablist"
      aria-label="API endpoint"
    >
      {options.map((option) => {
        const isActive = option.apiCompat === activeApiCompat;
        const label = API_COMPAT_THEME[option.apiCompat]?.label ?? option.apiCompat;
        return (
          <button
            key={option.apiCompat}
            type="button"
            role="tab"
            className={`endpoint-compat-tab${isActive ? " is-active" : ""}`}
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => onChange(option.apiCompat)}
          >
            <img
              className="endpoint-compat-tab-icon"
              src={ENDPOINT_ICONS[option.apiCompat]}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
            />
            <span className="endpoint-compat-tab-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
