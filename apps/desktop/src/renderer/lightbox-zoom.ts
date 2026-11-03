export const LIGHTBOX_ZOOM_MIN = 0.25;
export const LIGHTBOX_ZOOM_MAX = 8;
export const LIGHTBOX_ZOOM_STEP = 1.2;
export const LIGHTBOX_ZOOM_DEFAULT = 1;

export type LightboxZoomTransform = {
  scale: number;
  x: number;
  y: number;
};

export function clampLightboxZoom(scale: number): number {
  if (!Number.isFinite(scale)) return LIGHTBOX_ZOOM_DEFAULT;
  return Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, scale));
}

export function createLightboxZoomTransform(
  scale = LIGHTBOX_ZOOM_DEFAULT,
  x = 0,
  y = 0,
): LightboxZoomTransform {
  return { scale: clampLightboxZoom(scale), x, y };
}

/** Zoom toward a point in stage coordinates so that point stays fixed under the cursor. */
export function zoomLightboxAtPoint(
  current: LightboxZoomTransform,
  nextScale: number,
  point: { x: number; y: number },
): LightboxZoomTransform {
  const scale = clampLightboxZoom(nextScale);
  if (scale === current.scale) {
    return current;
  }
  const ratio = scale / current.scale;
  return {
    scale,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio,
  };
}

export function stepLightboxZoom(
  current: LightboxZoomTransform,
  direction: 1 | -1,
  point?: { x: number; y: number },
): LightboxZoomTransform {
  const nextScale = clampLightboxZoom(
    direction > 0 ? current.scale * LIGHTBOX_ZOOM_STEP : current.scale / LIGHTBOX_ZOOM_STEP,
  );
  if (!point) {
    return {
      scale: nextScale,
      x: nextScale === LIGHTBOX_ZOOM_DEFAULT ? 0 : current.x,
      y: nextScale === LIGHTBOX_ZOOM_DEFAULT ? 0 : current.y,
    };
  }
  const next = zoomLightboxAtPoint(current, nextScale, point);
  if (next.scale === LIGHTBOX_ZOOM_DEFAULT) {
    return createLightboxZoomTransform();
  }
  return next;
}

export function panLightboxZoom(
  current: LightboxZoomTransform,
  delta: { x: number; y: number },
): LightboxZoomTransform {
  if (current.scale <= LIGHTBOX_ZOOM_DEFAULT) {
    return current;
  }
  return {
    ...current,
    x: current.x + delta.x,
    y: current.y + delta.y,
  };
}

export function resetLightboxZoom(): LightboxZoomTransform {
  return createLightboxZoomTransform();
}

export function formatLightboxZoomPercent(scale: number): string {
  return `${Math.round(clampLightboxZoom(scale) * 100)}%`;
}

export function lightboxZoomCssTransform(transform: LightboxZoomTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

export type LightboxZoomSize = {
  width: number;
  height: number;
};

/** Fit content into box while preserving aspect ratio. */
export function computeContainSize(
  content: LightboxZoomSize,
  box: LightboxZoomSize,
  options?: { allowUpscale?: boolean },
): LightboxZoomSize {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { width: Math.max(1, box.width), height: Math.max(1, box.height) };
  }
  let scale = Math.min(box.width / content.width, box.height / content.height);
  if (options?.allowUpscale === false) {
    scale = Math.min(1, scale);
  }
  return {
    width: Math.max(1, content.width * scale),
    height: Math.max(1, content.height * scale),
  };
}

export function readSvgViewSize(svg: SVGSVGElement): LightboxZoomSize | null {
  try {
    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return { width: vb.width, height: vb.height };
    }
  } catch {
    // ignore invalid viewBox
  }
  const attrW = Number.parseFloat(svg.getAttribute("width") || "");
  const attrH = Number.parseFloat(svg.getAttribute("height") || "");
  if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
    return { width: attrW, height: attrH };
  }
  return null;
}

/**
 * Mermaid locks diagrams to a small inline max-width (diagram CSS px).
 * Re-size to fill the lightbox stage so vectors paint larger and look sharp.
 */
export function fitSvgIntoStage(svg: SVGSVGElement, stage: HTMLElement): void {
  const content = readSvgViewSize(svg);
  const box = { width: stage.clientWidth, height: stage.clientHeight };
  svg.removeAttribute("width");
  svg.removeAttribute("height");

  if (!content || box.width < 2 || box.height < 2) {
    // Unlock Mermaid's max-width; CSS contain rules finish the job after layout.
    svg.style.maxWidth = "100%";
    svg.style.maxHeight = "100%";
    svg.style.width = "100%";
    svg.style.height = "auto";
    return;
  }

  const sized = computeContainSize(content, box, { allowUpscale: true });
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  svg.style.width = `${sized.width}px`;
  svg.style.height = `${sized.height}px`;
}

/** Fit raster images to the stage; upscaling past native pixels is opt-in. */
export function fitImgIntoStage(img: HTMLImageElement, stage: HTMLElement, allowUpscale = false): void {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const box = { width: stage.clientWidth, height: stage.clientHeight };
  if (!nw || !nh || box.width < 2 || box.height < 2) {
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.width = "";
    img.style.height = "";
    return;
  }
  const sized = computeContainSize({ width: nw, height: nh }, box, { allowUpscale });
  img.style.maxWidth = "none";
  img.style.maxHeight = "none";
  img.style.width = `${sized.width}px`;
  img.style.height = `${sized.height}px`;
}

function prepareLightboxMedia(canvas: HTMLElement, stage: HTMLElement, allowUpscale = false): void {
  const svg = canvas.querySelector("svg");
  if (svg instanceof SVGSVGElement) {
    fitSvgIntoStage(svg, stage);
    return;
  }
  const img = canvas.querySelector("img");
  if (img instanceof HTMLImageElement) {
    fitImgIntoStage(img, stage, allowUpscale);
  }
}

export type LightboxZoomController = {
  getTransform: () => LightboxZoomTransform;
  setTransform: (next: LightboxZoomTransform) => void;
  zoomIn: (point?: { x: number; y: number }) => void;
  zoomOut: (point?: { x: number; y: number }) => void;
  reset: () => void;
  refit: () => void;
  destroy: () => void;
};

/**
 * CSS transform zoom/pan. Default view sizes media to the stage first (no transform),
 * so Mermaid is not stuck at its tiny intrinsic max-width.
 */
export function attachLightboxZoom(options: {
  stage: HTMLElement;
  canvas: HTMLElement;
  onChange?: (transform: LightboxZoomTransform) => void;
  /** Workspace previews fill the available canvas, including small source images. */
  allowUpscale?: boolean;
}): LightboxZoomController {
  let transform = createLightboxZoomTransform();
  let dragging = false;
  let lastPointer: { x: number; y: number } | null = null;
  let activePointerId: number | null = null;

  const refit = () => {
    if (transform.scale !== LIGHTBOX_ZOOM_DEFAULT || transform.x !== 0 || transform.y !== 0) {
      return;
    }
    prepareLightboxMedia(options.canvas, options.stage, options.allowUpscale);
  };

  const apply = () => {
    // Identity transform still creates a composited layer and softens SVG/text on HiDPI.
    // Only apply transform once the user actually pans or zooms.
    const idle =
      transform.scale === LIGHTBOX_ZOOM_DEFAULT && transform.x === 0 && transform.y === 0;
    if (idle) {
      options.canvas.style.transform = "";
      prepareLightboxMedia(options.canvas, options.stage, options.allowUpscale);
    } else {
      options.canvas.style.transform = lightboxZoomCssTransform(transform);
    }
    options.stage.classList.toggle("is-zoomed", transform.scale > LIGHTBOX_ZOOM_DEFAULT + 0.001);
    options.stage.classList.toggle("is-panning", dragging);
    options.onChange?.(transform);
  };

  const setTransform = (next: LightboxZoomTransform) => {
    transform = {
      scale: clampLightboxZoom(next.scale),
      x: next.x,
      y: next.y,
    };
    if (transform.scale === LIGHTBOX_ZOOM_DEFAULT) {
      transform = createLightboxZoomTransform();
    }
    apply();
  };

  const stagePoint = (event: { clientX: number; clientY: number }) => {
    const rect = options.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1;
    setTransform(stepLightboxZoom(transform, direction, stagePoint(event)));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (transform.scale <= LIGHTBOX_ZOOM_DEFAULT) return;
    dragging = true;
    activePointerId = event.pointerId;
    lastPointer = { x: event.clientX, y: event.clientY };
    options.stage.setPointerCapture(event.pointerId);
    options.stage.classList.add("is-panning");
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || activePointerId !== event.pointerId || !lastPointer) return;
    const delta = { x: event.clientX - lastPointer.x, y: event.clientY - lastPointer.y };
    lastPointer = { x: event.clientX, y: event.clientY };
    setTransform(panLightboxZoom(transform, delta));
  };

  const endDrag = (event: PointerEvent) => {
    if (activePointerId !== event.pointerId) return;
    dragging = false;
    activePointerId = null;
    lastPointer = null;
    options.stage.classList.remove("is-panning");
    if (options.stage.hasPointerCapture(event.pointerId)) {
      options.stage.releasePointerCapture(event.pointerId);
    }
  };

  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    if (transform.scale === LIGHTBOX_ZOOM_DEFAULT) {
      setTransform(zoomLightboxAtPoint(transform, 2, stagePoint(event)));
    } else {
      setTransform(resetLightboxZoom());
    }
  };

  const onImgLoad = () => {
    refit();
    apply();
  };
  const img = options.canvas.querySelector("img");
  if (img instanceof HTMLImageElement && !img.complete) {
    img.addEventListener("load", onImgLoad);
  }

  const onResize = () => {
    refit();
    apply();
  };
  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(options.stage);

  options.stage.addEventListener("wheel", onWheel, { passive: false });
  options.stage.addEventListener("pointerdown", onPointerDown);
  options.stage.addEventListener("pointermove", onPointerMove);
  options.stage.addEventListener("pointerup", endDrag);
  options.stage.addEventListener("pointercancel", endDrag);
  options.stage.addEventListener("dblclick", onDoubleClick);
  options.canvas.style.transformOrigin = "0 0";
  apply();
  requestAnimationFrame(() => {
    refit();
    apply();
  });

  return {
    getTransform: () => transform,
    setTransform,
    zoomIn: (point) => setTransform(stepLightboxZoom(transform, 1, point)),
    zoomOut: (point) => setTransform(stepLightboxZoom(transform, -1, point)),
    reset: () => setTransform(resetLightboxZoom()),
    refit: () => {
      refit();
      apply();
    },
    destroy: () => {
      if (img instanceof HTMLImageElement) {
        img.removeEventListener("load", onImgLoad);
      }
      resizeObserver?.disconnect();
      options.stage.removeEventListener("wheel", onWheel);
      options.stage.removeEventListener("pointerdown", onPointerDown);
      options.stage.removeEventListener("pointermove", onPointerMove);
      options.stage.removeEventListener("pointerup", endDrag);
      options.stage.removeEventListener("pointercancel", endDrag);
      options.stage.removeEventListener("dblclick", onDoubleClick);
      options.canvas.style.transform = "";
      options.canvas.style.transformOrigin = "";
    },
  };
}
