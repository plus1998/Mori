import { createContext, useContext, useEffect, useState } from "react";
import type { PromptImagePreview } from "../shared/prompt-image-metadata";
import { readPromptImageData } from "./composer-attachments";
import { i18n } from "./i18n";
import { ImageLightbox } from "./image-lightbox";
import { createImageObjectUrlFromBase64, revokeImageObjectUrl } from "./image-object-url";

/** Scope original-image reads to the conversation that owns the attachment. */
export const PromptImageContext = createContext<string | undefined>(undefined);

export function PromptImageLightbox({
  image,
  alt,
  label,
  onClose,
}: {
  image: PromptImagePreview;
  alt: string;
  label: string;
  onClose: () => void;
}) {
  const contextKey = useContext(PromptImageContext);
  const [state, setState] = useState<{ src: string; loading?: boolean; error?: string }>({
    src: "",
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ src: "", loading: true });
    void (async () => {
      let data = image.data ?? "";
      if (image.contentRef) {
        const readChunk = window.eco?.readPromptImageChunk;
        if (!contextKey || !readChunk) throw new Error(i18n.t("app.imagePreviewUnavailable"));
        // V2 data is a bounded thumbnail. Always resolve the durable reference for
        // the lightbox, even when data is present; it is not the original bytes.
        const original = await readPromptImageData({
          contextKey,
          contentRef: image.contentRef,
          mediaType: image.mediaType,
          readChunk,
        });
        data = original.data;
      }
      if (cancelled) return;
      objectUrl = createImageObjectUrlFromBase64(image.mediaType, data);
      setState({ src: objectUrl });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({
          src: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      cancelled = true;
      revokeImageObjectUrl(objectUrl);
    };
  }, [contextKey, image.contentRef, image.data, image.mediaType]);

  return (
    <ImageLightbox
      src={state.src}
      alt={alt}
      title={alt}
      dialogLabel={label}
      loading={Boolean(state.loading)}
      error={state.error}
      onClose={onClose}
    />
  );
}
