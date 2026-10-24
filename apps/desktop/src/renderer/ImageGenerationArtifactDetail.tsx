import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageGenerationArtifact } from "../shared/image-generation";
import { ImageLightbox } from "./image-lightbox";
import {
  createImageObjectUrlFromBase64,
  revokeImageObjectUrl,
  revokeImageObjectUrls,
} from "./image-object-url";

export function ImageGenerationArtifactDetail({ artifact }: { artifact: ImageGenerationArtifact }) {
  const { t } = useTranslation();
  const [previewIndex, setPreviewIndex] = useState<number>();
  const imageCount = artifact.images.length;
  const [images, setImages] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [revealError, setRevealError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    setImages([]);
    setLoadError(undefined);
    setRevealError(undefined);
    if (!imageCount) return;
    const eco = window.eco;
    if (!eco?.readImageGenerationArtifact) {
      setLoadError(t("settings.imageGeneration.desktopOnly"));
      return;
    }
    void Promise.all(
      Array.from({ length: imageCount }, (_, imageIndex) =>
        eco.readImageGenerationArtifact({ artifactId: artifact.id, imageIndex }),
      ),
    )
      .then((results) => {
        for (const result of results) {
          const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
          if (cancelled) {
            revokeImageObjectUrl(url);
            continue;
          }
          objectUrls.push(url);
        }
        if (!cancelled) {
          setImages([...objectUrls]);
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrls(objectUrls);
    };
  }, [artifact.id, imageCount, t]);

  async function handleRevealImage(imageIndex: number) {
    if (!window.eco?.revealImageGenerationArtifact) {
      setRevealError(t("task.image.openLocationUnavailable"));
      return;
    }
    setRevealError(undefined);
    try {
      await window.eco.revealImageGenerationArtifact({ artifactId: artifact.id, imageIndex });
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="image-artifact-detail">
      <header>
        <span className={`image-artifact-status is-${artifact.status}`}>
          {t(`task.image.status.${artifact.status}`)}
        </span>
        <span>
          {artifact.profileName} · {artifact.model}
        </span>
      </header>
      <section>
        <h3>{t("task.image.prompt")}</h3>
        <p className="image-artifact-prompt">{artifact.prompt}</p>
      </section>
      <section>
        <h3>{t("task.image.parameters")}</h3>
        <pre>{JSON.stringify(artifact.parameters, null, 2)}</pre>
      </section>
      {artifact.errorMessage ? (
        <section className="image-artifact-error">
          <h3>{artifact.errorCode ?? t("task.image.error")}</h3>
          <p>{artifact.errorMessage}</p>
        </section>
      ) : null}
      {loadError ? <p className="image-artifact-error">{loadError}</p> : null}
      {revealError ? (
        <p className="image-artifact-error" role="alert">
          {revealError}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="image-artifact-gallery">
          {images.map((source, index) => (
            <figure key={artifact.images[index]?.relativePath ?? index}>
              <button
                type="button"
                className="image-artifact-preview-button"
                onClick={() => setPreviewIndex(index)}
                aria-label={`${t("task.image.generated")} ${index + 1}`}
              >
                <img src={source} alt={`${t("task.image.generated")} ${index + 1}`} />
              </button>
              <figcaption className="image-artifact-caption">
                <span>{artifact.images[index]?.relativePath}</span>
                <button
                  type="button"
                  className="image-artifact-location-button"
                  onClick={() => void handleRevealImage(index)}
                  title={t("task.image.openLocation")}
                  aria-label={t("task.image.openLocation")}
                >
                  <FolderOpen size={13} aria-hidden />
                  <span>{t("task.image.openLocation")}</span>
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {previewIndex !== undefined && images[previewIndex] ? (
        <ImageLightbox
          src={images[previewIndex] ?? ""}
          alt={`${t("task.image.generated")} ${previewIndex + 1}`}
          title={t("task.image.generated")}
          dialogLabel={t("task.image.generated")}
          onClose={() => setPreviewIndex(undefined)}
          onOpenFolder={() => void handleRevealImage(previewIndex)}
          navigation={{
            index: previewIndex,
            count: images.length,
            onPrevious: () => setPreviewIndex((previewIndex + images.length - 1) % images.length),
            onNext: () => setPreviewIndex((previewIndex + 1) % images.length),
          }}
        />
      ) : null}
    </section>
  );
}
