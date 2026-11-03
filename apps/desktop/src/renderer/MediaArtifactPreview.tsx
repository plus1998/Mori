import { AudioLines } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MediaImageStage } from "./MediaImageStage";
import "./media-artifact-preview.css";

/** Native controls keep playback user initiated and expose seeking/volume/fullscreen. */
export function MediaArtifactPreview({
  src,
  mimeType,
  title,
  onOpenImage,
  layout = "inline",
}: {
  src: string;
  mimeType: string;
  title: string;
  onOpenImage: () => void;
  layout?: "inline" | "workspace";
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const onError = () => setFailed(true);
  const isAudio = mimeType.startsWith("audio/");
  const isVideo = mimeType.startsWith("video/");
  if (layout === "workspace" && !isAudio && !isVideo) {
    return <MediaImageStage key={src} src={src} title={title} onOpenImage={onOpenImage} />;
  }
  return (
    <div
      className={`media-artifact-preview${layout === "workspace" ? " media-artifact-preview--workspace" : ""}${isAudio ? " is-audio" : ""}`}
    >
      {layout === "workspace" && isAudio ? (
        <AudioLines size={42} className="media-workspace-audio-icon" aria-hidden />
      ) : null}
      {isVideo ? (
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          aria-label={title}
          style={layout === "inline" ? { width: "100%", maxHeight: 560 } : undefined}
          onError={onError}
        />
      ) : isAudio ? (
        <audio
          src={src}
          controls
          preload="metadata"
          aria-label={title}
          style={{ width: "100%" }}
          onError={onError}
        />
      ) : (
        <button
          type="button"
          className="run-log-image-view-preview"
          onClick={onOpenImage}
          aria-label={t("activity.imageDisplay.open", { name: title })}
          title={title}
        >
          <img src={src} alt={title} onError={onError} />
        </button>
      )}
      {failed ? <p role="alert">{t("activity.mediaDisplay.playbackFailed")}</p> : null}
    </div>
  );
}
