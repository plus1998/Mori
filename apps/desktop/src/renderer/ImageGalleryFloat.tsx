import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, LoaderCircle, Maximize2, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageGalleryQueueItem } from "./image-gallery-float-state";
import { ImageLightbox } from "./image-lightbox";
import {
  createImageObjectUrlFromBase64,
  revokeImageObjectUrl,
  revokeImageObjectUrls,
} from "./image-object-url";

/** 竖直画廊最多同时展示的层数：当前一张 + 下方两张排队预览。 */
const GALLERY_LAYER_COUNT = 3;

/** 单张图片加载后的数据：src 用于卡片与弹窗预览，fileName 用于展示图片标题。 */
interface LoadedImage {
  src: string;
  fileName?: string;
  /** 本地文件路径（有则可打开所在文件夹）。 */
  path?: string;
}

function galleryLayerTransform(layer: number): {
  y: number;
  scale: number;
  opacity: number;
  zIndex: number;
} {
  switch (layer) {
    case 0:
      return { y: 0, scale: 1, opacity: 1, zIndex: 30 };
    case 1:
      return { y: 44, scale: 0.965, opacity: 0.55, zIndex: 20 };
    default:
      return { y: 76, scale: 0.93, opacity: 0.28, zIndex: 10 };
  }
}

function GalleryCard({
  item,
  layer,
  image,
  onLoaded,
  onError,
  onPreview,
  onAdvance,
  onCloseAll,
}: {
  item: ImageGalleryQueueItem;
  layer: number;
  image: LoadedImage | undefined;
  onLoaded: (item: ImageGalleryQueueItem, image: LoadedImage) => void;
  onError: (item: ImageGalleryQueueItem, error: string) => void;
  onPreview: (item: ImageGalleryQueueItem) => void;
  onAdvance: (item: ImageGalleryQueueItem) => void;
  onCloseAll: () => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const isCurrent = layer === 0;
  const src = image?.src;
  const fileName = image?.fileName;
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (image) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    let handedOff = false;
    setError(undefined);
    const bridge = window.eco;
    if (!bridge) {
      setError(t("imageGallery.loadError"));
      onError(item, t("imageGallery.loadError"));
      return;
    }
    void (async () => {
      if (item.kind === "display") {
        const result = await bridge.readImageDisplay({ artifactId: item.artifactId });
        if (!result.ok) {
          const codeKey =
            result.code === "not_found"
              ? "notFound"
              : result.code === "too_large"
                ? "tooLarge"
                : result.code === "unsupported_type"
                  ? "unsupportedType"
                  : "readFailed";
          throw new Error(t(`activity.imageDisplay.error.${codeKey}`));
        }
        if (cancelled) return;
        const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
        if (cancelled) {
          revokeImageObjectUrl(url);
          return;
        }
        objectUrl = url;
        handedOff = true;
        onLoaded(item, { src: objectUrl, fileName: result.fileName, path: result.path });
        return;
      }
      const result = await bridge.readImageGenerationArtifact({
        artifactId: item.artifactId,
        imageIndex: item.imageIndex ?? 0,
      });
      if (cancelled) return;
      const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
      if (cancelled) {
        revokeImageObjectUrl(url);
        return;
      }
      objectUrl = url;
      handedOff = true;
      onLoaded(item, { src: objectUrl, path: result.path });
    })().catch((caught) => {
      if (!cancelled) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        onError(item, message);
      }
    });
    return () => {
      cancelled = true;
      if (!handedOff) {
        revokeImageObjectUrl(objectUrl);
      }
    };
  }, [item, image, t, onLoaded, onError]);

  const alt =
    item.kind === "display"
      ? t("activity.imageDisplay.previewAlt", { name: fileName ?? t("task.imageDisplay.emptyTitle") })
      : t("task.image.title");
  const transform = galleryLayerTransform(layer);

  return (
    <motion.div
      className={isCurrent ? "image-gallery-card image-gallery-card--current" : "image-gallery-card"}
      aria-hidden={!isCurrent}
      inert={!isCurrent}
      initial={false}
      animate={{
        y: transform.y,
        scale: transform.scale,
        opacity: transform.opacity,
        zIndex: transform.zIndex,
      }}
      transition={
        reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 280, damping: 28, mass: 0.9 }
      }
      style={{ pointerEvents: isCurrent ? "auto" : "none" }}
    >
      <div className="image-gallery-card-frame">
        {src ? (
          <button
            type="button"
            className="image-gallery-card-media"
            onClick={() => onPreview(item)}
            aria-label={t("imageGallery.preview")}
            title={t("imageGallery.preview")}
          >
            <img src={src} alt={alt} draggable={false} />
          </button>
        ) : error ? (
          <div className="image-gallery-card-media image-gallery-card-media--error" role="alert">
            {error}
          </div>
        ) : (
          <div className="image-gallery-card-media image-gallery-card-media--loading">
            <LoaderCircle className="image-gallery-card-spinner" size={22} aria-hidden />
            <span>{t("imageGallery.loading")}</span>
          </div>
        )}
        {isCurrent ? (
          <>
            {src ? (
              <button
                type="button"
                className="image-gallery-card-overlay image-gallery-card-overlay--preview"
                onClick={() => onPreview(item)}
                aria-label={t("imageGallery.preview")}
                title={t("imageGallery.preview")}
              >
                <Maximize2 size={20} aria-hidden />
              </button>
            ) : null}
            <div className="image-gallery-card-actions">
              <button
                type="button"
                className="image-gallery-card-overlay image-gallery-card-overlay--close"
                onClick={() => onAdvance(item)}
                aria-label={t("imageGallery.closeCurrent")}
                title={t("imageGallery.closeCurrent")}
              >
                <X size={16} aria-hidden />
              </button>
              <span className="image-gallery-card-actions-divider" aria-hidden />
              <button
                type="button"
                className="image-gallery-card-overlay image-gallery-card-overlay--close-all"
                onClick={onCloseAll}
                aria-label={t("imageGallery.closeAll")}
                title={`${t("imageGallery.closeAll")} (Esc)`}
                aria-keyshortcuts="Escape"
              >
                <XCircle size={17} aria-hidden />
              </button>
            </div>
          </>
        ) : null}
      </div>
    </motion.div>
  );
}

/**
 * 图片画廊悬浮窗：渲染在 Feed 列内（activity-workspace-shell），只在 Feed 上展示，
 * 不覆盖右侧 task 面板；cards 面板打开时由 avoidCards 向左偏移避开。
 * 保留竖直叠图，用方向键或分页按钮前后浏览；关闭当前张只移除这一张。
 * hover / 键盘聚焦时显示图片操作；关闭全部或 Esc 收起画廊，产物仍保留在 cards 中。
 */
export function ImageGalleryFloat({
  items,
  onAdvance,
  onCloseAll,
  avoidCards = false,
  focusKey,
}: {
  items: readonly ImageGalleryQueueItem[];
  onAdvance: (item: ImageGalleryQueueItem) => void;
  onCloseAll: () => void;
  avoidCards?: boolean;
  focusKey?: string | undefined;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [loadedImages, setLoadedImages] = useState<Record<string, LoadedImage>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const loadedImagesRef = useRef(loadedImages);
  loadedImagesRef.current = loadedImages;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey),
  );
  const currentItem = items[activeIndex];

  useEffect(() => {
    if (focusKey) setActiveKey(focusKey);
  }, [focusKey]);

  const closeCurrent = useCallback(
    (item: ImageGalleryQueueItem) => {
      setActiveKey((items[activeIndex + 1] ?? items[activeIndex - 1])?.key ?? null);
      onAdvance(item);
    },
    [items, activeIndex, onAdvance],
  );
  const previous = useCallback(() => {
    const item = items[activeIndex - 1];
    if (item) setActiveKey(item.key);
  }, [items, activeIndex]);
  const next = useCallback(() => {
    const item = items[activeIndex + 1];
    if (item) setActiveKey(item.key);
  }, [items, activeIndex]);
  const handleLoaded = useCallback((item: ImageGalleryQueueItem, image: LoadedImage) => {
    setLoadErrors((prev) => {
      if (!(item.key in prev)) return prev;
      const next = { ...prev };
      delete next[item.key];
      return next;
    });
    setLoadedImages((prev) => {
      const existing = prev[item.key];
      if (existing?.src === image.src) {
        return prev;
      }
      if (existing) {
        revokeImageObjectUrl(existing.src);
      }
      return { ...prev, [item.key]: image };
    });
  }, []);
  const handleError = useCallback((item: ImageGalleryQueueItem, error: string) => {
    setLoadErrors((prev) => ({ ...prev, [item.key]: error }));
  }, []);
  const handlePreview = useCallback((item: ImageGalleryQueueItem) => {
    setActiveKey(item.key);
    setPreviewOpen(true);
  }, []);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  useEffect(() => {
    const liveKeys = new Set(items.map((item) => item.key));
    setLoadedImages((prev) => {
      let changed = false;
      const next: Record<string, LoadedImage> = {};
      for (const [key, image] of Object.entries(prev)) {
        if (liveKeys.has(key)) {
          next[key] = image;
        } else {
          revokeImageObjectUrl(image.src);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  useEffect(() => {
    return () => {
      revokeImageObjectUrls(Object.values(loadedImagesRef.current).map((image) => image.src));
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // 弹窗接管自己的键盘操作，输入框、其他弹窗和菜单继续使用原有按键。
      if (
        previewOpen ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseAll();
      } else if (items.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        if (event.key === "ArrowLeft") previous();
        else next();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCloseAll, previewOpen, items.length, previous, next]);

  const previewItem = currentItem;
  const previewLoaded = previewItem ? loadedImages[previewItem.key] : undefined;
  const previewTitle = previewItem
    ? previewItem.kind === "display"
      ? (previewLoaded?.fileName ?? t("task.imageDisplay.emptyTitle"))
      : t("task.image.title")
    : "";
  const previewAlt = previewItem
    ? previewItem.kind === "display"
      ? t("activity.imageDisplay.previewAlt", { name: previewTitle })
      : t("task.image.title")
    : "";

  const revealPreviewFolder = useCallback(() => {
    const path = previewLoaded?.path;
    if (!path) return;
    const bridge = window.eco;
    if (!bridge?.revealImageInFolder) return;
    void bridge.revealImageInFolder({ path }).catch((error) => {
      console.warn("Failed to open the folder containing the image.", error);
    });
  }, [previewLoaded]);

  return (
    <motion.div
      className={avoidCards ? "image-gallery-float image-gallery-float--avoid-cards" : "image-gallery-float"}
      role="region"
      aria-label={t("imageGallery.title")}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 48, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 48, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.9 }}
    >
      <div className="image-gallery-float-stack">
        {items.slice(activeIndex, activeIndex + GALLERY_LAYER_COUNT).map((item, layer) => (
          <GalleryCard
            key={item.key}
            item={item}
            layer={layer}
            image={loadedImages[item.key]}
            onLoaded={handleLoaded}
            onError={handleError}
            onPreview={handlePreview}
            onAdvance={closeCurrent}
            onCloseAll={onCloseAll}
          />
        ))}
      </div>
      {items.length > 1 ? (
        <div className="image-gallery-navigation">
          <nav className="image-gallery-navigation-pill" aria-label={t("imageGallery.keyboardHint")}>
            <button
              type="button"
              onClick={previous}
              disabled={activeIndex === 0}
              aria-label={t("imageGallery.previous")}
              title={`${t("imageGallery.previous")} (←)`}
              aria-keyshortcuts="ArrowLeft"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <span
              className="image-gallery-position"
              role="status"
              aria-label={t("imageGallery.position", { current: activeIndex + 1, total: items.length })}
            >
              {activeIndex + 1}
              <span aria-hidden> / </span>
              {items.length}
            </span>
            <button
              type="button"
              onClick={next}
              disabled={activeIndex === items.length - 1}
              aria-label={t("imageGallery.next")}
              title={`${t("imageGallery.next")} (→)`}
              aria-keyshortcuts="ArrowRight"
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </nav>
          <span className="image-gallery-keyboard-hint">{t("imageGallery.keyboardHint")}</span>
        </div>
      ) : null}
      {previewOpen && previewItem ? (
        <ImageLightbox
          src={previewLoaded?.src ?? ""}
          loading={!previewLoaded && !loadErrors[previewItem.key]}
          error={loadErrors[previewItem.key]}
          alt={previewAlt}
          title={previewTitle}
          dialogLabel={t("imageGallery.preview")}
          {...(previewLoaded?.path ? { onOpenFolder: revealPreviewFolder } : {})}
          {...(items.length > 1
            ? { navigation: { index: activeIndex, count: items.length, onPrevious: previous, onNext: next } }
            : {})}
          onClose={closePreview}
        />
      ) : null}
    </motion.div>
  );
}
