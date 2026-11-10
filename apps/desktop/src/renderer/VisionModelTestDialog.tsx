import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import type { VisionModelSelection } from "../shared/vision-model";
import { evaluateVisionTest, type VisionModelTestResult } from "../shared/vision-model-test";
import { formatDurationMs, formatIpcInvokeError } from "./AppMessage";
import { createVisionTestSample } from "./vision-test-image";
import "./vision-model-test.css";

export function VisionModelTestDialog({
  selection,
  onClose,
}: {
  selection: VisionModelSelection;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeRequest = useRef<string | undefined>(undefined);
  const [sample] = useState(createVisionTestSample);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VisionModelTestResult>();
  const checks = result?.ok ? evaluateVisionTest(result.text, sample.expected) : undefined;
  const passed = checks?.filter((check) => check.passed).length;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      const requestId = activeRequest.current;
      activeRequest.current = undefined;
      if (requestId) void window.eco?.cancelVisionModelTest(requestId).catch(console.error);
    };
  }, []);

  async function run() {
    if (activeRequest.current) return;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setRunning(true);
    setResult(undefined);
    const started = performance.now();
    try {
      if (typeof window.eco?.testVisionModel !== "function") throw new Error(t("visionTest.unavailable"));
      const response = await window.eco.testVisionModel({
        requestId,
        selection,
        imageData: sample.imageData,
      });
      if (activeRequest.current === requestId) setResult(response);
    } catch (error) {
      if (activeRequest.current === requestId)
        setResult({
          ok: false,
          error: formatIpcInvokeError(error),
          elapsedMs: Math.round(performance.now() - started),
        });
    } finally {
      if (activeRequest.current === requestId) {
        activeRequest.current = undefined;
        setRunning(false);
      }
    }
  }

  function displayValue(value: unknown): string {
    if (value === undefined || value === null) return t("visionTest.missing");
    if (typeof value === "string" && ["red", "blue", "green", "circle", "square", "triangle"].includes(value))
      return t(`visionTest.value.${value}`);
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="settings-modal vision-test-dialog"
      aria-label={t("visionTest.title")}
      aria-modal="true"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="settings-modal-header">
        <h2 className="settings-modal-title">{t("visionTest.title")}</h2>
        <button type="button" className="vision-test-close" aria-label={t("common.close")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="settings-modal-body vision-test-body">
        <div>
          <p className="vision-test-model">{selection.modelId}</p>
          <p className="vision-test-hint">{t("visionTest.hint")}</p>
        </div>
        <img
          className="vision-test-image"
          src={sample.imageUrl}
          alt={t("visionTest.imageAlt")}
          width={720}
          height={360}
        />
        {running ? (
          <p className="vision-test-status" role="status">
            <Loader2 size={16} className="vision-test-spinner" />
            {t("visionTest.running")}
          </p>
        ) : null}
        {result ? (
          <div aria-live="polite">
            <p className={`vision-test-status ${!result.ok ? "is-error" : ""}`}>
              {result.ok
                ? checks
                  ? t("visionTest.score", { passed, total: checks.length })
                  : t("visionTest.unscored")
                : t("visionTest.failed")}
              <span className="vision-test-duration">{formatDurationMs(result.elapsedMs)}</span>
            </p>
            {checks ? (
              <table className="vision-test-checks">
                <thead>
                  <tr>
                    <th>{t("visionTest.item")}</th>
                    <th>{t("visionTest.expected")}</th>
                    <th>{t("visionTest.actual")}</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.map((check) => (
                    <tr key={check.key}>
                      <th scope="row">
                        <span className={check.passed ? "vision-test-pass" : "vision-test-fail"}>
                          {check.passed ? (
                            <Check size={14} aria-label={t("visionTest.correct")} />
                          ) : (
                            <X size={14} aria-label={t("visionTest.incorrect")} />
                          )}
                        </span>
                        {t(`visionTest.check.${check.key}`)}
                      </th>
                      <td>{displayValue(check.expected)}</td>
                      <td>{displayValue(check.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <p className="vision-test-hint">
              {result.ok ? t("visionTest.limit") : t("visionTest.errorHint")}
            </p>
            {result.ok ? (
              <details className="vision-test-response" open={!checks}>
                <summary>{t("visionTest.rawOutput")}</summary>
                <pre className="vision-test-output">{result.text}</pre>
              </details>
            ) : (
              <>
                <h3 className="vision-test-output-label">{t("visionTest.error")}</h3>
                <pre className="vision-test-output">{result.error}</pre>
              </>
            )}
          </div>
        ) : null}
      </div>
      <footer className="settings-modal-footer">
        <button type="button" className="settings-modal-cancel" onClick={onClose}>
          {t(running ? "visionTest.cancelClose" : "common.close")}
        </button>
        <button
          type="button"
          className="settings-modal-confirm"
          disabled={running}
          onClick={() => void run()}
        >
          {t(running ? "visionTest.testing" : result ? "visionTest.retry" : "visionTest.start")}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
