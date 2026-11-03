import { Expand, LoaderCircle, Minus, Plus, Scan, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  attachLightboxZoom,
  LIGHTBOX_ZOOM_MAX,
  LIGHTBOX_ZOOM_MIN,
  type LightboxZoomController,
} from "./lightbox-zoom";
import { useImageCopyMenu } from "./use-image-copy-menu";

/** Full-size workspace canvas. Message cards keep their separate compact preview. */
export function MediaImageStage({
  src,
  title,
  onOpenImage,
}: {
  src: string;
  title: string;
  onOpenImage: () => void;
}) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<LightboxZoomController | null>(null);
  const [scale, setScale] = useState(1);
  const [imagePercent, setImagePercent] = useState<number>();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const copyMenu = useImageCopyMenu(src);
  const zoomAtCenter = (direction: 1 | -1) => {
    const stage = stageRef.current;
    if (!stage) return;
    const center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    if (direction === 1) zoomRef.current?.zoomIn(center);
    else zoomRef.current?.zoomOut(center);
  };

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || failed) return;
    const zoom = attachLightboxZoom({
      stage,
      canvas,
      allowUpscale: true,
      onChange: (next) => {
        setScale(next.scale);
        const img = canvas.querySelector("img");
        if (img?.naturalWidth) {
          setImagePercent(Math.round((img.clientWidth / img.naturalWidth) * next.scale * 100));
        }
      },
    });
    zoomRef.current = zoom;
    return () => {
      zoom.destroy();
      zoomRef.current = null;
    };
  }, [src, failed]);

  return (
    <div className="media-image-workspace">
      <div className="media-image-workspace-surface">
        <div
          ref={stageRef}
          className="media-image-stage"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can focus the canvas to zoom.
          tabIndex={0}
          role="region"
          aria-label={title}
          onContextMenu={copyMenu.openMenu}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
            if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              zoomAtCenter(1);
            } else if (event.key === "-") {
              event.preventDefault();
              zoomAtCenter(-1);
            } else if (event.key === "0") {
              event.preventDefault();
              zoomRef.current?.reset();
            }
          }}
        >
          <div
            ref={canvasRef}
            className="media-image-canvas"
            style={{ visibility: loaded && !failed ? "visible" : "hidden" }}
          >
            <img
              src={src}
              alt={title}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          </div>
        </div>
        {!loaded && !failed ? (
          <div className="media-workspace-state" role="status">
            <LoaderCircle size={24} className="media-workspace-spinner" />
            {t("activity.imageDisplay.loading")}
          </div>
        ) : null}
        {failed ? (
          <div className="media-workspace-state is-error" role="alert">
            <TriangleAlert size={28} />
            {t("activity.mediaDisplay.playbackFailed")}
          </div>
        ) : null}
      </div>
      <div className="media-image-toolbar" role="toolbar" aria-label={t("task.imageDisplay.previewControls")}>
        <button
          type="button"
          onClick={() => zoomRef.current?.reset()}
          disabled={!loaded || failed}
          aria-label={t("task.imageDisplay.fit")}
          title={t("lightbox.zoomReset")}
        >
          <Scan size={15} aria-hidden />
          <span>{t("task.imageDisplay.fit")}</span>
        </button>
        <span className="media-image-toolbar-divider" aria-hidden />
        <button
          type="button"
          onClick={() => zoomAtCenter(-1)}
          disabled={!loaded || failed || scale <= LIGHTBOX_ZOOM_MIN}
          aria-label={t("lightbox.zoomOut")}
          title={t("lightbox.zoomOut")}
        >
          <Minus size={15} aria-hidden />
        </button>
        <output className="media-image-zoom">{imagePercent === undefined ? "—" : `${imagePercent}%`}</output>
        <button
          type="button"
          onClick={() => zoomAtCenter(1)}
          disabled={!loaded || failed || scale >= LIGHTBOX_ZOOM_MAX}
          aria-label={t("lightbox.zoomIn")}
          title={t("lightbox.zoomIn")}
        >
          <Plus size={15} aria-hidden />
        </button>
        <span className="media-image-toolbar-divider" aria-hidden />
        <button
          type="button"
          onClick={onOpenImage}
          disabled={!loaded || failed}
          aria-label={t("activity.imageDisplay.open", { name: title })}
          title={t("activity.imageDisplay.open", { name: title })}
        >
          <Expand size={15} aria-hidden />
        </button>
        {copyMenu.copyState ? (
          <span role="status" className="media-image-copy-status">
            {t(copyMenu.copyState === "copied" ? "lightbox.copyImageDone" : "lightbox.copyImageFailed")}
          </span>
        ) : null}
      </div>
      {copyMenu.menu}
    </div>
  );
}
