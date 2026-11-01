import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Native controls keep playback user initiated and expose seeking/volume/fullscreen. */
export function MediaArtifactPreview({
  src,
  mimeType,
  title,
  onOpenImage,
}: {
  src: string;
  mimeType: string;
  title: string;
  onOpenImage: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const onError = () => setFailed(true);
  return (
    <div className="media-artifact-preview">
      {mimeType.startsWith("video/") ? (
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          aria-label={title}
          style={{ width: "100%", maxHeight: 560 }}
          onError={onError}
        />
      ) : mimeType.startsWith("audio/") ? (
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
