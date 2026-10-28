import { Image as ImageIcon, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageDisplayArtifact } from "../shared/image-display";

export function ImageDisplayArtifactIcon({ artifact }: { artifact: ImageDisplayArtifact }) {
  const { t } = useTranslation();
  const key = `${artifact.id}:${artifact.updatedAt}`;
  const [preview, setPreview] = useState<{ key: string; src?: string; failed?: boolean }>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await window.eco?.readImageDisplay({ artifactId: artifact.id, thumbnail: true });
      if (cancelled) return;
      setPreview(
        result?.ok
          ? { key, src: `data:${result.mimeType};base64,${result.dataBase64}` }
          : { key, failed: true },
      );
    })().catch(() => {
      if (!cancelled) setPreview({ key, failed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, key]);
  const current = preview?.key === key ? preview : undefined;
  return (
    <span
      className="workspace-resource-row-icon workspace-image-artifact-thumbnail"
      aria-hidden="true"
      title={current?.failed ? t("task.imageDisplay.thumbnailUnavailable") : undefined}
    >
      {current?.src ? (
        <img
          src={current.src}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setPreview({ key, failed: true })}
        />
      ) : current?.failed ? (
        <ImageOff size={16} strokeWidth={1.75} />
      ) : (
        <ImageIcon size={16} strokeWidth={1.75} />
      )}
    </span>
  );
}
