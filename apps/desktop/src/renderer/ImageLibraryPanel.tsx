import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Image,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ImageLibraryBatchResult,
  ImageLibraryPage,
  ImageLibraryQuery,
  LibraryImage,
} from "../shared/image-library";
import { formatIpcInvokeError } from "./AppMessage";
import { GenerationCopyButton } from "./GenerationCopyButton";
import { ImageGenerationSourceLabel } from "./ImageGenerationSourceLabel";
import { i18n } from "./i18n";
import { createImageObjectUrlFromBase64, revokeImageObjectUrl } from "./image-object-url";
import { useImageLibraryRevision } from "./use-image-library-revision";
import "./image-library.css";

const PAGE_SIZE = 48;
function imageLibraryApi() {
  const api = window.eco;
  if (!api) throw new Error(i18n.t("settings.imageGeneration.desktopOnly"));
  return api;
}
export function imageLibraryBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LibraryPreview({
  id,
  thumbnail,
  revision,
  name,
}: {
  id: string;
  thumbnail: boolean;
  revision: number;
  name: string;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: library changes invalidate cached image bytes.
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setSrc("");
    setError("");
    void imageLibraryApi()
      .readImageLibraryImage(id, thumbnail)
      .then((result) => {
        if (cancelled) return;
        url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
        setSrc(url);
      })
      .catch((error) => {
        if (!cancelled) setError(formatIpcInvokeError(error));
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrl(url);
    };
  }, [id, thumbnail, revision]);
  return error ? (
    <span className="image-library-preview-error" role="status">
      {error}
    </span>
  ) : src ? (
    thumbnail ? (
      <img src={src} alt={name} loading="lazy" />
    ) : (
      <div className="generation-image-preview">
        <img src={src} alt={name} />
        <GenerationCopyButton kind="image" value={src} />
      </div>
    )
  ) : (
    <Image className="image-library-placeholder" aria-hidden />
  );
}

export function ImageLibraryPanel({
  onClose,
  onOpenThread,
}: {
  onClose(): void;
  onOpenThread(id: string): Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const api = imageLibraryApi();
  const libraryRevision = useImageLibraryRevision();
  const [refresh, setRefresh] = useState(0);
  const revision = libraryRevision + refresh;
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [threadId, setThreadId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ImageLibraryPage>();
  const [selected, setSelected] = useState<Map<string, LibraryImage>>(new Map());
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<LibraryImage>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [confirmation, setConfirmation] = useState<{ action: "trash" | "purge"; images: LibraryImage[] }>();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const query: ImageLibraryQuery = useMemo(
    () => ({ trash, search, workspacePath, threadId, fromDate, toDate, offset, limit: PAGE_SIZE }),
    [trash, search, workspacePath, threadId, fromDate, toDate, offset],
  );
  const filterKey = JSON.stringify([trash, search, workspacePath, threadId, fromDate, toDate]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change resets pagination and selection together.
  useEffect(() => {
    setOffset(0);
    setSelected(new Map());
    setConfirmation(undefined);
    setNotice("");
  }, [filterKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and library events reload the same query.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .listImageLibrary(query)
        .then((result) => {
          if (cancelled) return;
          if (query.offset && !result.items.length && result.total) {
            setOffset(Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE));
            return;
          }
          setPage(result);
          setError("");
          setLoading(false);
        })
        .catch((error) => {
          if (!cancelled) {
            setError(formatIpcInvokeError(error));
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore, trash and purge change the open image detail.
  useEffect(() => {
    if (!detailId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    setDetail(undefined);
    void api
      .getImageLibraryImage(detailId)
      .then((image) => {
        if (!cancelled) setDetail(image);
      })
      .catch((error) => {
        if (!cancelled) setError(formatIpcInvokeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, detailId, revision]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(formatIpcInvokeError(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const report = (result: ImageLibraryBatchResult) => {
    if (result.errors.length) setError(result.errors.map((item) => `${item.id}: ${item.message}`).join("\n"));
  };
  const mutate = (images: LibraryImage[], action: "trash" | "restore" | "purge") =>
    run(async () => {
      const result = await api.changeImageLibraryState(
        images.map((image) => image.id),
        action,
      );
      report(result);
      setSelected((current) => {
        const next = new Map(current);
        for (const id of result.succeededIds) next.delete(id);
        return next;
      });
      setConfirmation(undefined);
      if (result.succeededIds.length)
        setNotice(
          action === "purge"
            ? t("imageLibrary.purged", { size: imageLibraryBytes(result.freedBytes) })
            : t(action === "trash" ? "imageLibrary.moved" : "imageLibrary.restored"),
        );
      setRefresh((value) => value + 1);
    });
  const exportImages = (images: LibraryImage[]) =>
    run(async () => {
      const result = await api.exportImageLibraryImages(images.map((image) => image.id));
      report(result);
      if (result.succeededIds.length)
        setNotice(t("imageLibrary.exported", { count: result.succeededIds.length }));
    });
  const matching = async (input: ImageLibraryQuery) => {
    const images: LibraryImage[] = [];
    for (let start = 0; ; start += 100) {
      const result = await api.listImageLibrary({ ...input, offset: start, limit: 100 });
      if (result.total > 10000) throw new Error(t("imageLibrary.tooMany"));
      images.push(...result.items);
      if (start + result.items.length >= result.total || !result.items.length)
        return [...new Map(images.map((image) => [image.id, image])).values()];
    }
  };
  const selectedImages = [...selected.values()];
  const selectedBytes = selectedImages.reduce((sum, image) => sum + image.bytes, 0);
  const choose = (image: LibraryImage) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(image.id)) next.delete(image.id);
      else next.set(image.id, image);
      return next;
    });
  const buttons = (images: LibraryImage[], inTrash: boolean) => (
    <>
      <button
        type="button"
        disabled={busy || !images.length || images.some((image) => image.missing)}
        onClick={() => void exportImages(images)}
      >
        <Download size={15} />
        {t("imageLibrary.export")}
      </button>
      {inTrash ? (
        <>
          <button
            type="button"
            disabled={busy || !images.length}
            onClick={() => void mutate(images, "restore")}
          >
            <Undo2 size={15} />
            {t("imageLibrary.restore")}
          </button>
          <button
            type="button"
            disabled={busy || !images.length}
            onClick={() => setConfirmation({ action: "purge", images })}
          >
            <Trash2 size={15} />
            {t("imageLibrary.purge")}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || !images.length}
          onClick={() => setConfirmation({ action: "trash", images })}
        >
          <Trash2 size={15} />
          {t("imageLibrary.delete")}
        </button>
      )}
    </>
  );

  return (
    <div className="image-library-backdrop">
      <div
        className="image-library-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-library-title"
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (confirmation) setConfirmation(undefined);
            else if (detailId) setDetailId(undefined);
            else if (!busy) onClose();
          }
          if (event.key !== "Tab") return;
          const nodes = [
            ...(panelRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ) ?? []),
          ].filter((node) => node.getClientRects().length);
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="image-library-header">
          <div>
            <h2 id="image-library-title">
              <Image size={21} />
              {t("imageLibrary.title")}
            </h2>
            <p>{t("imageLibrary.subtitle")}</p>
          </div>
          <button
            type="button"
            ref={closeRef}
            disabled={busy}
            aria-label={t("imageLibrary.close")}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="image-library-notices" aria-live="polite">
          {error && (
            <p className="image-library-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p>{notice}</p>}
        </div>
        {confirmation && (
          <section
            className="image-library-confirm"
            role="alertdialog"
            aria-modal="false"
            aria-label={t(confirmation.action === "trash" ? "imageLibrary.delete" : "imageLibrary.purge")}
          >
            <p>
              {t(
                confirmation.action === "trash" ? "imageLibrary.confirmTrash" : "imageLibrary.confirmPurge",
                {
                  count: confirmation.images.length,
                  size: imageLibraryBytes(confirmation.images.reduce((sum, image) => sum + image.bytes, 0)),
                },
              )}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(confirmation.images, confirmation.action)}
            >
              {t(confirmation.action === "trash" ? "imageLibrary.delete" : "imageLibrary.purge")}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>
              {t("imageLibrary.cancel")}
            </button>
          </section>
        )}
        {detailId ? (
          <div className="image-library-detail">
            <button type="button" onClick={() => setDetailId(undefined)}>
              <ArrowLeft size={16} />
              {t("imageLibrary.all")}
            </button>
            {detail ? (
              <>
                <div className="image-library-detail-preview">
                  {detail.purgedAt ? (
                    <p>{t("imageLibrary.deleted")}</p>
                  ) : (
                    <LibraryPreview
                      id={detail.id}
                      thumbnail={false}
                      revision={revision}
                      name={detail.fileName}
                    />
                  )}
                </div>
                <h3>{detail.fileName}</h3>
                {detail.trashedAt && !detail.purgedAt && <p>{t("imageLibrary.trashed")}</p>}
                <div className="image-library-actions">
                  {!detail.purgedAt && buttons([detail], !!detail.trashedAt)}
                </div>
                <dl>
                  <dt className="generation-metadata-heading">
                    {t("imageLibrary.prompt")}
                    <GenerationCopyButton value={detail.prompt} label={t("imageLibrary.copyPrompt")} />
                  </dt>
                  <dd>{detail.prompt}</dd>
                  <dt>{t("imageLibrary.generationSource")}</dt>
                  <dd>
                    <ImageGenerationSourceLabel
                      provider={detail.provider}
                      profileName={detail.profileName}
                      accounts={detail.account ? [detail.account] : undefined}
                    />
                  </dd>
                  <dt>{t("imageLibrary.model")}</dt>
                  <dd>
                    {detail.provider} · {detail.model}
                  </dd>
                  <dt>{t("imageLibrary.created")}</dt>
                  <dd>{new Date(detail.createdAt).toLocaleString(i18n.language)}</dd>
                  <dt>{t("imageLibrary.dimensions")}</dt>
                  <dd>
                    {detail.width} × {detail.height} · {imageLibraryBytes(detail.bytes)}
                  </dd>
                  <dt>{t("imageLibrary.project")}</dt>
                  <dd>{detail.workspacePath}</dd>
                  <dt>{t("imageLibrary.source")}</dt>
                  <dd>
                    {detail.sourceKind === "project"
                      ? t("imageLibrary.projectGeneration")
                      : (detail.sourceTitle ?? detail.threadId)}
                    {detail.sourceKind === "project" ? null : detail.sourceDeleted ? (
                      ` · ${t("imageLibrary.deletedSource")}`
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => onOpenThread(detail.threadId))}
                      >
                        {t("imageLibrary.openSource")}
                      </button>
                    )}
                  </dd>
                  <dt className="generation-metadata-heading">
                    {t("imageLibrary.parameters")}
                    <GenerationCopyButton
                      value={JSON.stringify(detail.parameters, null, 2)}
                      label={t("imageLibrary.copyParameters")}
                    />
                  </dt>
                  <dd>
                    <pre>{JSON.stringify(detail.parameters, null, 2)}</pre>
                  </dd>
                </dl>
              </>
            ) : (
              <p>{t("imageLibrary.loading")}</p>
            )}
          </div>
        ) : (
          <>
            <div className="image-library-tabs">
              <button type="button" aria-pressed={!trash} onClick={() => setTrash(false)}>
                {t("imageLibrary.all")}
              </button>
              <button type="button" aria-pressed={trash} onClick={() => setTrash(true)}>
                {t("imageLibrary.trash")}
              </button>
            </div>
            <div className="image-library-filters">
              <input
                type="search"
                aria-label={t("imageLibrary.search")}
                placeholder={t("imageLibrary.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                aria-label={t("imageLibrary.projects")}
                value={workspacePath}
                onChange={(event) => {
                  setWorkspacePath(event.target.value);
                  setThreadId("");
                }}
              >
                <option value="">{t("imageLibrary.projects")}</option>
                {page?.projects.map((project) => (
                  <option key={project} value={project}>
                    {project.split(/[\\/]/).pop() || project}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("imageLibrary.threads")}
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
              >
                <option value="">{t("imageLibrary.threads")}</option>
                {page?.threads
                  .filter((thread) => !workspacePath || thread.workspacePath === workspacePath)
                  .map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.title ?? thread.id}
                    </option>
                  ))}
              </select>
              <label>
                {t("imageLibrary.from")}
                <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </label>
              <label>
                {t("imageLibrary.to")}
                <input
                  type="date"
                  min={fromDate}
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={loading || busy}
                aria-label={t("imageLibrary.refresh")}
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            <div className="image-library-actions">
              <span>
                {selected.size
                  ? t("imageLibrary.selected", {
                      count: selected.size,
                      size: imageLibraryBytes(selectedBytes),
                    })
                  : t("imageLibrary.count", {
                      count: page?.total ?? 0,
                      size: imageLibraryBytes(page?.bytes ?? 0),
                    })}
              </span>
              <button
                type="button"
                disabled={busy || loading || !page?.items.length}
                onClick={() => {
                  if (!page) return;
                  setSelected(
                    (current) =>
                      new Map([...current, ...page.items.map((image) => [image.id, image] as const)]),
                  );
                }}
              >
                {t("imageLibrary.selectPage")}
              </button>
              <button
                type="button"
                disabled={busy || loading || !page?.total}
                onClick={() =>
                  void run(async () =>
                    setSelected(new Map((await matching(query)).map((image) => [image.id, image]))),
                  )
                }
              >
                {t("imageLibrary.selectAll")}
              </button>
              {selected.size > 0 && (
                <>
                  <button type="button" disabled={busy} onClick={() => setSelected(new Map())}>
                    {t("imageLibrary.clearSelection")}
                  </button>
                  {buttons(selectedImages, trash)}
                </>
              )}
              {trash && (
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() =>
                    void run(async () => {
                      const images = await matching({ trash: true });
                      if (images.length) setConfirmation({ action: "purge", images });
                    })
                  }
                >
                  {t("imageLibrary.emptyTrash")}
                </button>
              )}
            </div>
            <div className="image-library-content" aria-busy={loading}>
              {loading ? (
                <p>{t("imageLibrary.loading")}</p>
              ) : !page?.items.length ? (
                <div className="image-library-empty">
                  <Image size={40} />
                  <h3>{t("imageLibrary.empty")}</h3>
                  <p>{t("imageLibrary.emptyHint")}</p>
                </div>
              ) : (
                <div className="image-library-grid">
                  {page.items.map((image) => (
                    <article key={image.id} className={selected.has(image.id) ? "is-selected" : ""}>
                      <input
                        type="checkbox"
                        aria-label={t("imageLibrary.select", { name: image.fileName })}
                        checked={selected.has(image.id)}
                        disabled={busy}
                        onChange={() => choose(image)}
                      />
                      <button
                        type="button"
                        className="image-library-card-preview"
                        aria-label={t("imageLibrary.preview", { name: image.fileName })}
                        onClick={() => setDetailId(image.id)}
                      >
                        {image.missing ? (
                          <span>{t("imageLibrary.missing")}</span>
                        ) : (
                          <LibraryPreview id={image.id} thumbnail revision={revision} name={image.fileName} />
                        )}
                      </button>
                      <div className="image-library-caption">
                        <strong title={image.fileName}>{image.fileName}</strong>
                        <span>
                          {image.width} × {image.height} · {imageLibraryBytes(image.bytes)}
                        </span>
                        <time>{new Date(image.createdAt).toLocaleString(i18n.language)}</time>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <footer className="image-library-pagination">
              <button
                type="button"
                disabled={busy || loading || !offset}
                onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              >
                <ChevronLeft size={16} />
                {t("imageLibrary.previous")}
              </button>
              <span>{t("imageLibrary.page", { page: Math.floor(offset / PAGE_SIZE) + 1 })}</span>
              <button
                type="button"
                disabled={busy || loading || offset + PAGE_SIZE >= (page?.total ?? 0)}
                onClick={() => setOffset((value) => value + PAGE_SIZE)}
              >
                {t("imageLibrary.next")}
                <ChevronRight size={16} />
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
