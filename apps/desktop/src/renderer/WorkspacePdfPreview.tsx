import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import {
  GlobalWorkerOptions,
  getDocument,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function WorkspacePdfPreview({
  url,
  size,
  name,
}: {
  url: string;
  size: number;
  name: string;
}) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [rendering, setRendering] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setDocument(undefined);
    setError(undefined);
    setPageNumber(1);
    setZoom(1);
    // PDF.js' built-in fetch transport only enables byte ranges for HTTP(S).
    // Use its range transport for our workspace protocol, keeping large PDFs on demand.
    const transport = new PDFDataRangeTransport(size, null, true, name);
    const assetRoot = new URL("pdfjs/", window.document.baseURI).href;
    const task = getDocument({
      range: transport,
      disableAutoFetch: true,
      cMapUrl: `${assetRoot}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetRoot}standard_fonts/`,
      iccUrl: `${assetRoot}iccs/`,
      wasmUrl: `${assetRoot}wasm/`,
    });
    transport.abort = () => controller.abort();
    transport.requestDataRange = (begin, end) => {
      void fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: controller.signal })
        .then(async (response) => {
          if (response.status !== 206) throw new Error(t("fileBrowser.pdfRangeError"));
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== end - begin) throw new Error(t("fileBrowser.pdfRangeError"));
          if (active) transport.onDataRange(begin, bytes);
        })
        .catch((caught) => {
          if (!active || controller.signal.aborted) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          void task.destroy();
        });
    };
    void task.promise
      .then((value) => {
        if (active) setDocument(value);
      })
      .catch((caught) => {
        if (active && !controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
      controller.abort();
      void task.destroy();
    };
  }, [url, size, name, t]);

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(120, element.clientWidth - 32)));
    setWidth(Math.max(120, element.clientWidth - 32));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let render: RenderTask | undefined;
    setRendering(true);
    void document
      .getPage(pageNumber)
      .then(async (page) => {
        if (!active || !canvas.current) return;
        const scale = (width / page.getViewport({ scale: 1 }).width) * zoom;
        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const element = canvas.current;
        element.width = Math.ceil(viewport.width * pixelRatio);
        element.height = Math.ceil(viewport.height * pixelRatio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = page.render({ canvas: element, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await render.promise;
        if (active) setRendering(false);
      })
      .catch((caught) => {
        if (active) {
          setRendering(false);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, pageNumber, width, zoom]);

  return (
    <div className="workspace-pdf-preview">
      <div className="workspace-file-browser__mode-toggle workspace-pdf-preview__toolbar">
        <button
          type="button"
          className="workspace-file-browser__mode-btn"
          aria-label={t("fileBrowser.previousPage")}
          disabled={!document || pageNumber <= 1}
          onClick={() => setPageNumber((value) => value - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        <span>{document ? `${pageNumber} / ${document.numPages}` : t("fileBrowser.loadingPreview")}</span>
        <button
          type="button"
          className="workspace-file-browser__mode-btn"
          aria-label={t("fileBrowser.nextPage")}
          disabled={!document || pageNumber >= document.numPages}
          onClick={() => setPageNumber((value) => value + 1)}
        >
          <ChevronRight size={15} />
        </button>
        <button
          type="button"
          className="workspace-file-browser__mode-btn"
          aria-label={t("fileBrowser.zoomOut")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          <Minus size={15} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="workspace-file-browser__mode-btn"
          aria-label={t("fileBrowser.zoomIn")}
          disabled={zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          <Plus size={15} />
        </button>
      </div>
      {error ? (
        <p role="alert" className="workspace-file-browser__error">
          {error}
        </p>
      ) : null}
      <div ref={body} className="workspace-pdf-preview__body" aria-busy={rendering || !document}>
        <canvas ref={canvas} aria-label={t("fileBrowser.pdfPage", { name, page: pageNumber })} />
      </div>
    </div>
  );
}
