import { useVirtualizer } from "@tanstack/react-virtual";
import type { File } from "gitdiff-parser";
import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type DiffDisplayHunk,
  type DiffDisplayLine,
  fileToDisplayHunks,
  flattenDisplayLines,
} from "./diff-display-lines";
import { highlightDiffInWorker } from "./diff-highlight-client";
import { resolveShikiLanguage } from "./diff-highlight-language";
import { MaterialFileIcon } from "./MaterialFileIcon";
import {
  countDiffFileStats,
  diffFilePath,
  parseDiff,
  resolveDiffFilePath,
  resolveDiffLanguage,
} from "./prosemirror/diff-from-patch";

export {
  countDiffFileStats,
  parseDiff,
  resolveDiffFilePath,
  resolveDiffLanguage,
} from "./prosemirror/diff-from-patch";

interface GitDiffViewerProps {
  patch: string;
  selectedPath?: string;
  emptyLabel?: string;
  /** @deprecated Ignored — review renders structured patch hunks only. */
  originalContent?: string;
  /** @deprecated Ignored — review renders structured patch hunks only. */
  currentContent?: string;
  additions?: number;
  deletions?: number;
}

function readAppTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => readAppTheme());
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const DiffLinesView = memo(function DiffLinesView({
  path,
  hunks,
  scrollRef,
}: {
  path: string;
  hunks: DiffDisplayHunk[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const theme = useAppTheme();
  const language = useMemo(() => resolveShikiLanguage(path), [path]);
  const flatLines = useMemo(() => flattenDisplayLines(hunks), [hunks]);
  const [highlighted, setHighlighted] = useState<{
    lines: DiffDisplayLine[];
    theme: string;
    htmls: (string | null)[];
  }>();
  const [highlightError, setHighlightError] = useState<string>();
  const lineHtml = highlighted?.lines === flatLines && highlighted.theme === theme ? highlighted.htmls : [];
  const hunkStarts = useMemo(() => {
    const starts = new Set<number>();
    let offset = 0;
    for (let index = 0; index < hunks.length; index++) {
      if (index > 0) starts.add(offset);
      offset += hunks[index]!.lines.length;
    }
    return starts;
  }, [hunks]);
  const virtualized = flatLines.length > 300;
  const virtualizer = useVirtualizer({
    count: flatLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => 21 + (hunkStarts.has(index) ? 9 : 0),
    overscan: 12,
    enabled: virtualized,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const controller = new AbortController();
    setHighlightError(undefined);
    void highlightDiffInWorker(flatLines, language, theme, controller.signal)
      .then((htmls) => {
        if (!controller.signal.aborted) setHighlighted({ lines: flatLines, theme, htmls });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setHighlightError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [flatLines, language, theme]);

  const renderLine = (line: DiffDisplayLine, index: number) => {
    const html = lineHtml[index];
    return (
      <div className={`pm-diff-line is-${line.kind}`} data-kind={line.kind}>
        <span className="pm-diff-line-nos" aria-hidden="true">
          <span className="pm-diff-line-no pm-diff-line-no--old">{line.oldNo ?? ""}</span>
          <span className="pm-diff-line-no pm-diff-line-no--new">{line.newNo ?? ""}</span>
        </span>
        {html ? (
          <span className="pm-diff-line-text is-highlighted" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span className="pm-diff-line-text">{line.text.length > 0 ? line.text : "\u00a0"}</span>
        )}
      </div>
    );
  };
  return (
    <>
      {highlightError ? (
        <p className="workspace-diff-drawer-error-banner" role="alert">
          {t("workspace.diff.highlightFailed", { message: highlightError })}
        </p>
      ) : null}
      <div
        className="workspace-diff-code-editor pm-diff-viewer"
        data-diff-lang={language}
        data-diff-row-count={flatLines.length}
      >
        {virtualized ? (
          <div
            style={{
              paddingTop: virtualItems[0]?.start ?? 0,
              paddingBottom: Math.max(0, virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0)),
            }}
          >
            {virtualItems.map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className={`pm-diff-row${hunkStarts.has(row.index) ? " is-hunk-start" : ""}`}
              >
                {renderLine(flatLines[row.index]!, row.index)}
              </div>
            ))}
          </div>
        ) : (
          flatLines.map((line, index) => (
            <div key={index} className={`pm-diff-row${hunkStarts.has(index) ? " is-hunk-start" : ""}`}>
              {renderLine(line, index)}
            </div>
          ))
        )}
      </div>
    </>
  );
});

export function GitDiffViewer({ patch, selectedPath, emptyLabel, additions, deletions }: GitDiffViewerProps) {
  const { t } = useTranslation();
  const files = useMemo(() => {
    const trimmed = patch.trim();
    if (!trimmed) {
      return [];
    }
    try {
      return parseDiff(trimmed);
    } catch {
      return [];
    }
  }, [patch]);

  const visibleFiles = useMemo(() => {
    if (!selectedPath) {
      return files;
    }
    return files.filter((file) => diffFilePath(file) === selectedPath);
  }, [files, selectedPath]);

  if (!patch.trim()) {
    return <p className="workspace-diff-empty">{emptyLabel ?? t("workspace.diff.noChanges")}</p>;
  }

  if (visibleFiles.length === 0) {
    return <p className="workspace-diff-empty">{t("workspace.diff.parseFailed")}</p>;
  }

  return (
    <div className="workspace-diff-viewer">
      {visibleFiles.map((file) => (
        <DiffFileReview
          key={diffFilePath(file)}
          file={file}
          {...(additions !== undefined ? { additions } : {})}
          {...(deletions !== undefined ? { deletions } : {})}
        />
      ))}
    </div>
  );
}

const DiffFileReview = memo(function DiffFileReview({
  file,
  additions,
  deletions,
}: {
  file: File;
  additions?: number;
  deletions?: number;
}) {
  const { t } = useTranslation();
  const path = diffFilePath(file);
  const stats = useMemo(() => {
    if (additions !== undefined && deletions !== undefined) {
      return { additions, deletions };
    }
    return countDiffFileStats(file);
  }, [additions, deletions, file]);
  const hunks = useMemo(() => fileToDisplayHunks(file), [file]);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <section className="workspace-diff-file-review">
      <header className="workspace-diff-file-toolbar">
        <div className="workspace-diff-file-identity" title={path}>
          <MaterialFileIcon path={path} size={16} className="workspace-diff-file-icon" />
          <span className="workspace-diff-file-toolbar-path">{path}</span>
          <span
            className="workspace-diff-file-stats"
            aria-label={t("workspace.diff.changedRows", {
              count: stats.additions + stats.deletions,
            })}
          >
            <span className="diff-stat-add">+{stats.additions}</span>
            <span className="diff-stat-del">-{stats.deletions}</span>
          </span>
        </div>
      </header>
      <div className="workspace-diff-code-scroll" ref={scrollRef}>
        <DiffLinesView path={path} hunks={hunks} scrollRef={scrollRef} />
      </div>
    </section>
  );
});
