import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isEcoTtsToolName, type TtsArtifact } from "../shared/tts";
import "./tts.css";

export const TtsArtifactsContext = createContext<readonly TtsArtifact[]>([]);
export const TtsFeedGroupDetailsContext = createContext(false);

export function TtsArtifactPlayer({
  artifact,
  onOpen,
}: {
  artifact: TtsArtifact;
  onOpen?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const player = useRef<HTMLAudioElement>(null);
  const mounted = useRef(true);
  const objectUrl = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  async function loadAndPlay() {
    if (loading) return;
    setLoading(true);
    setError(undefined);
    try {
      if (!window.eco?.readTtsArtifact) throw new Error(t("settings.tts.desktopOnly"));
      const result = await window.eco.readTtsArtifact({ artifactId: artifact.id, audioIndex: 0 });
      if (!mounted.current) return;
      const data = Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([data], { type: result.mimeType }));
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setSource(url);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!source || !player.current) return;
    void player.current.play().catch((caught) => {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [source]);

  return (
    <article className="tts-artifact-player" aria-label={t("settings.tts.title")}>
      <div className="tts-artifact-player-meta">
        <span>
          {t(`task.tts.status.${artifact.status}`)} · {artifact.parameters.voice} · {artifact.model}
        </span>
        {onOpen ? (
          <button type="button" className="settings-secondary-button" onClick={() => onOpen(artifact.id)}>
            {t("task.tts.details")}
          </button>
        ) : null}
      </div>
      <p className="tts-artifact-transcript">{artifact.text}</p>
      <details>
        <summary>{t("task.tts.transcript")}</summary>
        <p>{artifact.text}</p>
      </details>
      <details>
        <summary>{t("task.tts.style")}</summary>
        <p>{artifact.parameters.style}</p>
      </details>
      {artifact.status === "completed" && artifact.audio.length > 0 ? (
        source ? (
          // biome-ignore lint/a11y/useMediaCaption: The complete verbatim transcript is rendered in the adjacent disclosure.
          <audio
            ref={player}
            controls
            preload="none"
            src={source}
            onError={() => setError(t("task.tts.playbackError"))}
          />
        ) : (
          <button
            type="button"
            className="settings-secondary-button"
            disabled={loading}
            onClick={() => void loadAndPlay()}
          >
            {t(loading ? "task.tts.loading" : "task.tts.play")}
          </button>
        )
      ) : null}
      {artifact.audio.length > 0 ? (
        <button
          type="button"
          className="settings-secondary-button"
          onClick={() => {
            if (!window.eco?.revealTtsArtifact) {
              setError(t("settings.tts.desktopOnly"));
              return;
            }
            void window.eco.revealTtsArtifact({ artifactId: artifact.id, audioIndex: 0 }).catch((caught) => {
              if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
            });
          }}
        >
          {t("task.tts.reveal")}
        </button>
      ) : null}
      {artifact.errorMessage ? (
        <p role="alert" className="browser-settings-error">
          {artifact.errorCode}: {artifact.errorMessage}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="browser-settings-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Works for both full tool metadata and V2 skeleton rows; no Feed detail fetch required. */
export function readTtsToolUseId(item: {
  metadata?: Record<string, unknown> | undefined;
}): string | undefined {
  const tool = item.metadata?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const record = tool as Record<string, unknown>;
  return typeof record.name === "string" &&
    isEcoTtsToolName(record.name) &&
    typeof record.toolUseId === "string"
    ? record.toolUseId
    : undefined;
}

export function TtsFeedArtifacts({ toolUseIds }: { toolUseIds: readonly string[] }) {
  const artifacts = useContext(TtsArtifactsContext);
  const groupDetails = useContext(TtsFeedGroupDetailsContext);
  if (groupDetails) return null;
  const ids = new Set(toolUseIds);
  const matches = artifacts.filter((artifact) => artifact.toolUseId && ids.has(artifact.toolUseId));
  return matches.length > 0 ? (
    <div className="tts-feed-artifacts">
      {matches.map((artifact) => (
        <TtsArtifactPlayer key={artifact.id} artifact={artifact} />
      ))}
    </div>
  ) : null;
}
