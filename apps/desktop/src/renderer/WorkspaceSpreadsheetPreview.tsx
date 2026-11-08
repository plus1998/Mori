import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_BYTES,
  SPREADSHEET_PREVIEW_ROWS,
  type SpreadsheetPreviewRequest,
  type SpreadsheetPreviewResponse,
  type SpreadsheetPreviewSheet,
} from "../shared/spreadsheet-preview";

export default function WorkspaceSpreadsheetPreview({ url, size }: { url: string; size: number }) {
  const { t } = useTranslation();
  const id = useId();
  const workerRef = useRef<Worker | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [sheet, setSheet] = useState<SpreadsheetPreviewSheet>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setNames([]);
    setSelectedName("");
    setSheet(undefined);
    setError(undefined);
    const fail = (message: string) => {
      if (controller.signal.aborted) return;
      setError(message);
      clearTimeout(timeout);
      worker?.terminate();
      workerRef.current = null;
      controller.abort();
    };
    void (async () => {
      try {
        if (size > SPREADSHEET_PREVIEW_MAX_BYTES) throw new Error(t("fileBrowser.spreadsheetTooLarge"));
        timeout = setTimeout(() => fail(t("fileBrowser.spreadsheetTimeout")), 30_000);
        worker = new Worker(new URL("./workspace-spreadsheet.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<SpreadsheetPreviewResponse>) => {
          if (controller.signal.aborted) return;
          const result = event.data;
          if (result.type === "error") return fail(result.message);
          clearTimeout(timeout);
          if (result.type === "loaded") {
            setNames(result.names);
            setSelectedName(result.sheet.name);
          }
          setSheet(result.sheet);
        };
        worker.onerror = (event) => fail(event.message || t("fileBrowser.readFailed"));
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(t("fileBrowser.readFailed"));
        const length = response.headers.get("Content-Length");
        if (length !== null && Number(length) !== size) throw new Error(t("fileBrowser.spreadsheetChanged"));
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        if (bytes.byteLength !== size) throw new Error(t("fileBrowser.spreadsheetChanged"));
        const request: SpreadsheetPreviewRequest = { type: "load", bytes };
        worker.postMessage(request, [bytes]);
      } catch (caught) {
        fail(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
      worker?.terminate();
      workerRef.current = null;
    };
  }, [url, size, t]);

  const loading = !error && (!sheet || sheet.name !== selectedName);
  return (
    <div className="workspace-table-preview workspace-spreadsheet-preview" aria-busy={loading}>
      <div className="workspace-file-browser__status">{t("fileBrowser.spreadsheetNotice")}</div>
      {error ? (
        <p role="alert" className="workspace-file-browser__error">
          {t("fileBrowser.spreadsheetFailed", { message: error })}
        </p>
      ) : loading ? (
        <div className="workspace-file-browser__message">{t("fileBrowser.loadingPreview")}</div>
      ) : sheet ? (
        <>
          {sheet.limited ? (
            <div className="workspace-file-browser__status">
              {t("fileBrowser.spreadsheetLimit", {
                rows: SPREADSHEET_PREVIEW_ROWS,
                columns: SPREADSHEET_PREVIEW_COLUMNS,
              })}
            </div>
          ) : null}
          <div
            ref={scrollRef}
            className="workspace-table-preview__scroll"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-sheet-${names.indexOf(sheet.name)}`}
          >
            {sheet.rows.length ? (
              <table aria-label={sheet.name}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    {sheet.columns.map((column) => (
                      <th scope="col" key={column}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => (
                    <tr key={row.number}>
                      <th scope="row">{row.number}</th>
                      {row.cells.map((cell) => (
                        <td
                          key={cell.address}
                          rowSpan={cell.rowSpan}
                          colSpan={cell.colSpan}
                          title={cell.formula ? `${cell.address}: =${cell.formula}` : cell.address}
                        >
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="workspace-file-browser__message">{t("fileBrowser.spreadsheetEmpty")}</div>
            )}
          </div>
        </>
      ) : null}
      {names.length ? (
        <div
          className="workspace-spreadsheet-preview__tabs"
          role="tablist"
          aria-label={t("fileBrowser.spreadsheetSheets")}
        >
          {names.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${id}-sheet-${index}`}
              aria-controls={`${id}-panel`}
              aria-selected={name === selectedName}
              className={`workspace-file-browser__mode-btn ${name === selectedName ? "is-active" : ""}`}
              disabled={Boolean(error)}
              onClick={() => {
                setSelectedName(name);
                scrollRef.current?.scrollTo(0, 0);
                const request: SpreadsheetPreviewRequest = { type: "sheet", name };
                workerRef.current?.postMessage(request);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
