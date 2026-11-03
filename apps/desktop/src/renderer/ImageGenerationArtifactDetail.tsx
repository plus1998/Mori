import { Download, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageGenerationArtifact } from "../shared/image-generation";
import { ImageLightbox } from "./image-lightbox";
import { formatIpcInvokeError } from "./AppMessage";
import { useImageLibraryRevision } from "./use-image-library-revision";
import {
  createImageObjectUrlFromBase64,
  revokeImageObjectUrl,
  revokeImageObjectUrls,
} from "./image-object-url";

export function ImageGenerationArtifactDetail({ artifact }: { artifact: ImageGenerationArtifact }) {
  const { t } = useTranslation();
  const [previewIndex, setPreviewIndex] = useState<number>();
  const imageCount = artifact.images.length;
  const libraryRevision = useImageLibraryRevision();
  const [images, setImages] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [imageErrors, setImageErrors] = useState<Record<number, string>>({});
  const [revealError, setRevealError] = useState<string>();
  const availableIndexes = images.flatMap((source, index) => (source ? [index] : []));

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    setPreviewIndex(undefined);
    setImages([]);
    setLoadError(undefined);
    setImageErrors({});
    setRevealError(undefined);
    if (!imageCount) return;
    const eco = window.eco;
    if (!eco?.readImageGenerationArtifact) {
      setLoadError(t("settings.imageGeneration.desktopOnly"));
      return;
    }
    void Promise.allSettled(
      Array.from({ length: imageCount }, (_, imageIndex) =>
        eco.readImageGenerationArtifact({ artifactId: artifact.id, imageIndex }),
      ),
    )
      .then((results) => {
        const sources: string[] = [];
        const errors: Record<number, string> = {};
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            sources.push("");
            errors[index] = formatIpcInvokeError(result.reason);
            return;
          }
          const url = createImageObjectUrlFromBase64(result.value.mimeType, result.value.dataBase64);
          if (cancelled) revokeImageObjectUrl(url);
          else objectUrls.push(url);
          sources.push(url);
        });
        if (!cancelled) {
          setImages(sources);
          setImageErrors(errors);
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrls(objectUrls);
    };
  }, [artifact.id, imageCount, libraryRevision, t]);

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
              {source ? (
                <button
                  type="button"
                  className="image-artifact-preview-button"
                  onClick={() => setPreviewIndex(index)}
                  aria-label={`${t("task.image.generated")} ${index + 1}`}
                >
                  <img src={source} alt={`${t("task.image.generated")} ${index + 1}`} />
                </button>
              ) : (
                <p className="image-artifact-error" role="status">
                  {imageErrors[index]}
                </p>
              )}
              <figcaption className="image-artifact-caption">
                <span>
                  {artifact.images[index]?.libraryImageId
                    ? artifact.images[index]?.absolutePath.split(/[\\/]/).pop()
                    : artifact.images[index]?.relativePath}
                </span>
                {artifact.images[index]?.libraryImageId && source ? (
                  <button
                    type="button"
                    className="image-artifact-location-button"
                    onClick={() => {
                      const id = artifact.images[index]?.libraryImageId;
                      if (!id || !window.eco) return;
                      void window.eco
                        .exportImageLibraryImages([id])
                        .then((result) => {
                          if (result.errors.length)
                            setRevealError(result.errors.map((error) => error.message).join("\n"));
                        })
                        .catch((error) => setRevealError(String(error)));
                    }}
                  >
                    <Download size={13} aria-hidden />
                    <span>{t("imageLibrary.export")}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!source}
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
            index: availableIndexes.indexOf(previewIndex),
            count: availableIndexes.length,
            onPrevious: () =>
              setPreviewIndex(
                availableIndexes[
                  (availableIndexes.indexOf(previewIndex) + availableIndexes.length - 1) %
                    availableIndexes.length
                ],
              ),
            onNext: () =>
              setPreviewIndex(
                availableIndexes[(availableIndexes.indexOf(previewIndex) + 1) % availableIndexes.length],
              ),
          }}
        />
      ) : null}
    </section>
  );
}
