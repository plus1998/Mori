import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { i18n } from "./i18n";
import {
  attachLightboxZoom,
  formatLightboxZoomPercent,
  LIGHTBOX_ZOOM_DEFAULT,
  type LightboxZoomController,
  type LightboxZoomTransform,
} from "./lightbox-zoom";
import { useImageCopyMenu } from "./use-image-copy-menu";

export function ImageLightbox({
  src,
  alt,
  title,
  dialogLabel,
  onOpenFolder,
  onClose,
  sidePanel,
  navigation,
  loading = false,
  error,
}: {
  src: string;
  alt: string;
  title: string;
  dialogLabel: string;
  /** 可选：图片对应本地文件时提供，用于在文件管理器中显示所在文件夹。 */
  onOpenFolder?: () => void;
  onClose: () => void;
  /**
   * 可选：图片右侧的补充内容位。查看图像这类工具会把它的提示词与返回内容放进
   * 这个 slot，于是预览变成左图右文；不传时布局与只有图片时完全一致。
   */
  sidePanel?: ReactNode;
  navigation?: { index: number; count: number; onPrevious: () => void; onNext: () => void };
  loading?: boolean;
  error?: string | undefined;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<LightboxZoomController | null>(null);
  const [transform, setTransform] = useState<LightboxZoomTransform>({
    scale: LIGHTBOX_ZOOM_DEFAULT,
    x: 0,
    y: 0,
  });
  const copyMenu = useImageCopyMenu(src);
  const canZoom = Boolean(src) && !loading && !error;

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
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
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"]',
        )
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (navigation && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        if (event.key === "ArrowLeft" && navigation.index > 0) navigation.onPrevious();
        if (event.key === "ArrowRight" && navigation.index < navigation.count - 1) navigation.onNext();
        return;
      }
      const zoom = zoomRef.current;
      if (!zoom) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom.zoomIn();
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoom.zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        zoom.reset();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, navigation]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    if (!src) {
      setTransform({ scale: LIGHTBOX_ZOOM_DEFAULT, x: 0, y: 0 });
      return;
    }
    const controller = attachLightboxZoom({
      stage,
      canvas,
      onChange: setTransform,
    });
    zoomRef.current = controller;
    return () => {
      controller.destroy();
      zoomRef.current = null;
    };
  }, [src]);

  const zoomIn = useCallback(() => zoomRef.current?.zoomIn(), []);
  const zoomOut = useCallback(() => zoomRef.current?.zoomOut(), []);
  const resetZoom = useCallback(() => zoomRef.current?.reset(), []);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="run-log-image-view-lightbox"
      onMouseDown={(event) => {
        // Right-clicking the backdrop must not close the viewer: that press belongs to the
        // context menu, and closing here would eat the menu before it can open.
        if (event.button === 0 && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="run-log-image-view-lightbox-content"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={dialogLabel}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first || !last) {
            event.preventDefault();
          } else if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="run-log-image-view-lightbox-bar">
          <span title={title}>{title}</span>
          {navigation ? (
            <nav className="lightbox-gallery-navigation" aria-label={i18n.t("imageGallery.keyboardHint")}>
              <button
                type="button"
                className="run-log-image-view-lightbox-close"
                onClick={navigation.onPrevious}
                disabled={navigation.index === 0}
                aria-label={i18n.t("imageGallery.previous")}
                title={`${i18n.t("imageGallery.previous")} (←)`}
                aria-keyshortcuts="ArrowLeft"
              >
                <ChevronLeft size={17} aria-hidden />
              </button>
              <span
                className="image-gallery-position"
                role="status"
                aria-label={i18n.t("imageGallery.position", {
                  current: navigation.index + 1,
                  total: navigation.count,
                })}
              >
                {navigation.index + 1}
                <span aria-hidden> / </span>
                {navigation.count}
              </span>
              <button
                type="button"
                className="run-log-image-view-lightbox-close"
                onClick={navigation.onNext}
                disabled={navigation.index === navigation.count - 1}
                aria-label={i18n.t("imageGallery.next")}
                title={`${i18n.t("imageGallery.next")} (→)`}
                aria-keyshortcuts="ArrowRight"
              >
                <ChevronRight size={17} aria-hidden />
              </button>
            </nav>
          ) : null}
          <div className="lightbox-zoom-controls">
            {copyMenu.copyState ? (
              <span
                className={`run-log-image-view-lightbox-status run-log-image-view-lightbox-status--${copyMenu.copyState}`}
                role="status"
              >
                {copyMenu.copyState === "copied" ? (
                  <Check size={14} aria-hidden />
                ) : (
                  <TriangleAlert size={14} aria-hidden />
                )}
                <span>
                  {copyMenu.copyState === "copied"
                    ? i18n.t("lightbox.copyImageDone")
                    : i18n.t("lightbox.copyImageFailed")}
                </span>
              </span>
            ) : null}
            <button
              type="button"
              className="run-log-image-view-lightbox-close"
              onClick={zoomOut}
              disabled={!canZoom}
              title={i18n.t("lightbox.zoomOut")}
              aria-label={i18n.t("lightbox.zoomOut")}
            >
              <Minus size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="lightbox-zoom-percent"
              onClick={resetZoom}
              disabled={!canZoom}
              title={i18n.t("lightbox.zoomReset")}
              aria-label={i18n.t("lightbox.zoomReset")}
            >
              {formatLightboxZoomPercent(transform.scale)}
            </button>
            <button
              type="button"
              className="run-log-image-view-lightbox-close"
              onClick={zoomIn}
              disabled={!canZoom}
              title={i18n.t("lightbox.zoomIn")}
              aria-label={i18n.t("lightbox.zoomIn")}
            >
              <Plus size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="run-log-image-view-lightbox-close"
              onClick={resetZoom}
              disabled={!canZoom}
              title={i18n.t("lightbox.zoomReset")}
              aria-label={i18n.t("lightbox.zoomReset")}
            >
              <RotateCcw size={15} aria-hidden />
            </button>
            {onOpenFolder ? (
              <button
                type="button"
                className="run-log-image-view-lightbox-close"
                onClick={onOpenFolder}
                title={i18n.t("lightbox.openFolder")}
                aria-label={i18n.t("lightbox.openFolder")}
              >
                <FolderOpen size={16} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="run-log-image-view-lightbox-close"
              onClick={onClose}
              title={i18n.t("common.close")}
              aria-label={i18n.t("common.close")}
            >
              <X size={18} aria-hidden />
            </button>
          </div>
        </div>
        <div className="run-log-image-view-lightbox-body">
          <div
            ref={stageRef}
            className="run-log-image-view-lightbox-stage lightbox-zoom-stage"
            onContextMenu={src ? copyMenu.openMenu : undefined}
          >
            <div ref={canvasRef} className="lightbox-zoom-canvas">
              {error ? (
                <div className="lightbox-gallery-message" role="alert">
                  <TriangleAlert size={22} aria-hidden />
                  <span>{error}</span>
                </div>
              ) : loading ? (
                <div className="lightbox-gallery-message" role="status">
                  <LoaderCircle className="image-gallery-card-spinner" size={22} aria-hidden />
                  <span>{i18n.t("imageGallery.loading")}</span>
                </div>
              ) : (
                <img src={src} alt={alt} draggable={false} />
              )}
            </div>
          </div>
          {sidePanel ? <aside className="run-log-image-view-lightbox-side">{sidePanel}</aside> : null}
        </div>
        {copyMenu.menu}
      </div>
    </div>,
    document.body,
  );
}
