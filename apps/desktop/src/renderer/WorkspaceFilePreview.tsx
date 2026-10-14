import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Check, Eye, Pencil, RotateCcw, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "./MarkdownContent";
import { useImageCopyMenu } from "./use-image-copy-menu";
import { clampTargetColumn, clampTargetLine, languageForFile } from "./workspace-file-browser-logic";

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  kind: "text" | "image" | "audio" | "video" | "unsupported";
  mimeType?: string;
  content?: string;
  base64?: string;
  truncated?: boolean;
  reason?: string;
}

export interface WorkspaceFilePreviewTarget {
  line?: number;
  column?: number;
  requestId: number;
}

interface WorkspaceWriteApi {
  writeWorkspaceFile(input: {
    workspacePath: string;
    filePath: string;
    content: string;
  }): Promise<{ path: string; name: string; size: number }>;
}

/**
 * CodeMirror 浅色主题本身几乎不带 token 配色，深色依赖 oneDark；
 * 两边都挂独立 HighlightStyle，避免只剩默认 fallback 导致「看起来没高亮」。
 */
const LazyCodeMirror = lazy(async () => {
  const [
    { default: CodeMirror },
    { languages },
    { EditorView, highlightActiveLine, keymap },
    { HighlightStyle, LanguageDescription, syntaxHighlighting },
    { tags },
  ] = await Promise.all([
    import("@uiw/react-codemirror"),
    import("@codemirror/language-data"),
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@lezer/highlight"),
  ]);

  const softLightHighlighting = syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.comment, color: "#8a9a8f", fontStyle: "italic" },
      { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: "#8b5fbf" },
      { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#b16b45" },
      { tag: [tags.string, tags.special(tags.string)], color: "#5d9165" },
      { tag: [tags.number, tags.bool, tags.atom, tags.null], color: "#4387c5" },
      { tag: [tags.typeName, tags.className, tags.namespace], color: "#7167a8" },
      { tag: [tags.function(tags.variableName)], color: "#587aa3" },
      { tag: [tags.propertyName, tags.labelName], color: "#a06f4d" },
      { tag: [tags.operator, tags.punctuation], color: "#4e83b5" },
      { tag: [tags.meta, tags.annotation], color: "#8870a7" },
      { tag: tags.invalid, color: "#b65f68" },
    ]),
  );

  /** oneDark 已带语法色；再补一层同色系，防止 reconfigure / fallback 竞态后 token 无色。 */
  const softDarkHighlighting = syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.comment, color: "#7d8799", fontStyle: "italic" },
      { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: "#c678dd" },
      { tag: [tags.variableName, tags.definition(tags.variableName)], color: "#e06c75" },
      { tag: [tags.string, tags.special(tags.string)], color: "#98c379" },
      { tag: [tags.number, tags.bool, tags.atom, tags.null], color: "#d19a66" },
      { tag: [tags.typeName, tags.className, tags.namespace], color: "#e5c07b" },
      { tag: [tags.function(tags.variableName)], color: "#61afef" },
      { tag: [tags.propertyName, tags.labelName], color: "#e06c75" },
      { tag: [tags.operator, tags.punctuation], color: "#56b6c2" },
      { tag: [tags.meta, tags.annotation], color: "#7d8799" },
      { tag: tags.invalid, color: "#ffffff" },
    ]),
  );

  function resolveLanguageDescription(filePath: string) {
    const byFilename = LanguageDescription.matchFilename(languages, filePath);
    if (byFilename) return byFilename;
    const mapped = languageForFile(filePath);
    if (!mapped) return undefined;
    // matchLanguageName 会匹配 name + alias（例如 cpp → C++）
    return LanguageDescription.matchLanguageName(languages, mapped, true) ?? undefined;
  }

  return {
    default: function WorkspaceCodeEditor({
      content,
      path,
      targetLine,
      targetColumn,
      className,
      readOnly = true,
      onChange,
      onSave,
    }: {
      content: string;
      path: string;
      targetLine?: number;
      targetColumn?: number;
      className?: string;
      readOnly?: boolean;
      onChange?: (value: string) => void;
      onSave?: () => void;
    }) {
      const [extension, setExtension] = useState<Extension | null>(null);
      const [ready, setReady] = useState(false);
      const editorRef = useRef<EditorView | null>(null);
      const onSaveRef = useRef(onSave);
      onSaveRef.current = onSave;
      const [theme, setTheme] = useState<"dark" | "light">(() =>
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
      const scrollToTarget = useCallback(
        (view: EditorView, lineNumber: number | undefined) => {
          if (lineNumber === undefined || lineNumber > view.state.doc.lines) return;
          const line = view.state.doc.line(lineNumber);
          const column = clampTargetColumn(targetColumn, line.length) ?? 1;
          const anchor = line.from + column - 1;
          view.dispatch({
            selection: { anchor },
            effects: EditorView.scrollIntoView(anchor, { y: "center" }),
          });
        },
        [targetColumn],
      );
      useEffect(() => {
        let active = true;
        setExtension(null);
        setReady(false);
        const description = resolveLanguageDescription(path);
        if (!description) {
          // 无匹配语言也要标记 ready，避免编辑器一直不挂载
          setReady(true);
          return () => {
            active = false;
          };
        }
        void description
          .load()
          .then((loaded) => {
            if (active) {
              setExtension(loaded);
              setReady(true);
            }
          })
          .catch((error: unknown) => {
            // 缺口：load 失败时编辑器仍可读，但不能 silently 变成「无语法色」而不留痕迹
            console.warn("[WorkspaceFilePreview] language load failed", path, error);
            if (active) setReady(true);
          });
        return () => {
          active = false;
        };
      }, [path]);
      useEffect(() => {
        const root = document.documentElement;
        const updateTheme = () => setTheme(root.dataset.theme === "dark" ? "dark" : "light");
        updateTheme();
        const observer = new MutationObserver(updateTheme);
        observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
      }, []);
      useEffect(() => {
        if (editorRef.current) scrollToTarget(editorRef.current, targetLine);
      }, [content, path, scrollToTarget, targetColumn, targetLine]);
      const saveKeymap = useMemo(
        () =>
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current?.();
                return true;
              },
              preventDefault: true,
            },
          ]),
        [],
      );
      // useMemo：避免每次 render 新建 extensions 触发 reconfigure，冲掉刚挂上的 language support
      const editableExtensions = useMemo(
        () => [
          EditorView.lineWrapping,
          highlightActiveLine(),
          theme === "light" ? softLightHighlighting : softDarkHighlighting,
          ...(readOnly ? [] : [saveKeymap]),
          ...(extension ? [extension] : []),
        ],
        [extension, readOnly, saveKeymap, theme],
      );
      // 语言就绪后再挂载编辑器，避免「先空挂再 reconfigure」导致高亮不刷新
      if (!ready) {
        return <div className={className ?? "workspace-file-browser__editor"} />;
      }
      return (
        <CodeMirror
          className={className ?? "workspace-file-browser__editor"}
          value={content}
          theme={theme}
          readOnly={readOnly}
          basicSetup={{
            foldGutter: false,
            foldKeymap: false,
          }}
          extensions={editableExtensions}
          {...(onChange ? { onChange } : {})}
          onCreateEditor={(view) => {
            editorRef.current = view;
            scrollToTarget(view, targetLine);
          }}
        />
      );
    },
  };
});

function dataUrl(file: WorkspaceFile): string | undefined {
  return file.base64 && file.mimeType ? `data:${file.mimeType};base64,${file.base64}` : undefined;
}

/** 复制结果的小浮标：图片预览右上角，几秒后自动消失。 */
function MediaCopyStatus({ state }: { state: "copied" | "failed" }) {
  const { t } = useTranslation();
  return (
    <span
      className={`workspace-file-browser__copy-status workspace-file-browser__copy-status--${state}`}
      role="status"
    >
      {state === "copied" ? <Check size={13} aria-hidden /> : <TriangleAlert size={13} aria-hidden />}
      <span>{state === "copied" ? t("lightbox.copyImageDone") : t("lightbox.copyImageFailed")}</span>
    </span>
  );
}

/**
 * 图片 / 音频 / 视频预览。图片支持右键复制到剪贴板，与图片浏览器（ImageLightbox）共用同一套
 * 右键菜单与复制管线：PNG 原样写入，其他格式重编码为 PNG。
 */
function WorkspaceMediaPreview({ file }: { file: WorkspaceFile }) {
  const { t } = useTranslation();
  const src = dataUrl(file);
  const copyMenu = useImageCopyMenu(src);
  if (!src) {
    return <div className="workspace-file-browser__message">{t("fileBrowser.mediaMissing")}</div>;
  }
  const isImage = file.kind === "image";
  return (
    <div
      className="workspace-file-browser__media-wrap"
      {...(isImage ? { onContextMenu: copyMenu.openMenu } : {})}
    >
      {isImage ? <img className="workspace-file-browser__media" src={src} alt={file.name} /> : null}
      {file.kind === "audio" ? (
        <audio className="workspace-file-browser__audio" src={src} controls aria-label={file.name} />
      ) : null}
      {file.kind === "video" ? (
        <video className="workspace-file-browser__media" src={src} controls aria-label={file.name} />
      ) : null}
      {copyMenu.copyState ? <MediaCopyStatus state={copyMenu.copyState} /> : null}
      {copyMenu.menu}
    </div>
  );
}

/** SVG 预览（文本源码渲染出来的图）同样可以右键复制，写入时重编码为 PNG。 */
function WorkspaceSvgPreview({ name, draft }: { name: string; draft: string }) {
  const svgDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(draft)))}`;
  const copyMenu = useImageCopyMenu(svgDataUrl);
  return (
    <div className="workspace-file-browser__svg-preview" onContextMenu={copyMenu.openMenu}>
      <img src={svgDataUrl} alt={name} className="workspace-file-browser__svg-image" />
      {copyMenu.copyState ? <MediaCopyStatus state={copyMenu.copyState} /> : null}
      {copyMenu.menu}
    </div>
  );
}

export function WorkspaceFilePreview({
  file,
  target,
  workspacePath,
  onDirtyChange,
}: {
  file: WorkspaceFile;
  target?: WorkspaceFilePreviewTarget;
  workspacePath?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const editable = file.kind === "text" && !file.truncated && Boolean(workspacePath);
  const [viewMode, setViewMode] = useState<"edit" | "preview">("preview");
  const baselineRef = useRef(file.content ?? "");
  const [draft, setDraft] = useState(file.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  // 判断是否是 Markdown 或 SVG 文件
  const isMarkdown = useMemo(() => {
    const ext = file.path.toLowerCase().split(".").pop();
    return ext === "md" || ext === "markdown";
  }, [file.path]);

  const isSvg = useMemo(() => {
    const ext = file.path.toLowerCase().split(".").pop();
    return ext === "svg";
  }, [file.path]);

  const isHtml = useMemo(() => {
    const ext = file.path.toLowerCase().split(".").pop();
    return ext === "html" || ext === "htm";
  }, [file.path]);

  // 对于 Markdown 和 SVG 文件，默认使用预览模式
  useEffect(() => {
    if (isMarkdown || isSvg) {
      setViewMode("preview");
    } else {
      setViewMode("edit");
    }
  }, [isMarkdown, isSvg, file.path]);

  const showModeToggle = (isMarkdown || isSvg) && editable;

  useEffect(() => {
    const next = file.content ?? "";
    baselineRef.current = next;
    setDraft(next);
    setDirty(false);
    setSaveStatus("idle");
    setSaveError(null);
    onDirtyChangeRef.current?.(false);
  }, [file.content, file.path, target?.requestId]);

  const updateDirty = useCallback((nextDraft: string) => {
    const nextDirty = nextDraft !== baselineRef.current;
    setDirty(nextDirty);
    onDirtyChangeRef.current?.(nextDirty);
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      updateDirty(value);
      if (saveStatus === "error") {
        setSaveStatus("idle");
        setSaveError(null);
      }
    },
    [saveStatus, updateDirty],
  );

  const handleSave = useCallback(async () => {
    if (!editable || !workspacePath || savingRef.current) return;
    if (draftRef.current === baselineRef.current) return;
    const api = window.eco as unknown as WorkspaceWriteApi | undefined;
    if (!api?.writeWorkspaceFile) {
      setSaveStatus("error");
      setSaveError(t("fileBrowser.apiUnavailable"));
      return;
    }
    savingRef.current = true;
    setSaveStatus("saving");
    setSaveError(null);
    const contentToSave = draftRef.current;
    try {
      await api.writeWorkspaceFile({
        workspacePath,
        filePath: file.path,
        content: contentToSave,
      });
      baselineRef.current = contentToSave;
      setDirty(false);
      onDirtyChangeRef.current?.(false);
      setSaveStatus("idle");
    } catch (error) {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : t("fileBrowser.unknownError"));
    } finally {
      savingRef.current = false;
    }
  }, [editable, file.path, t, workspacePath]);

  if (file.kind === "image" || file.kind === "audio" || file.kind === "video") {
    return <WorkspaceMediaPreview file={file} />;
  }
  if (file.kind === "unsupported") {
    return (
      <div className="workspace-file-browser__message">{file.reason || t("fileBrowser.unsupported")}</div>
    );
  }
  const lines = draft.split(/\r?\n/).length;
  const targetLine = clampTargetLine(target?.line, lines);
  const selectedLineLength =
    targetLine === undefined ? undefined : draft.split(/\r?\n/)[targetLine - 1]?.length;
  const targetColumn =
    selectedLineLength === undefined ? undefined : clampTargetColumn(target?.column, selectedLineLength);
  const statusMessage =
    saveStatus === "saving"
      ? t("fileBrowser.saving")
      : saveStatus === "error"
        ? `${t("fileBrowser.saveFailed")}: ${saveError || t("fileBrowser.unknownError")}`
        : dirty
          ? t("fileBrowser.unsaved")
          : null;

  // 渲染预览内容
  const renderPreviewContent = () => {
    if (isMarkdown) {
      return (
        <div className="workspace-file-browser__markdown-preview">
          <MarkdownContent
            text={draft}
            {...(workspacePath
              ? { localImageContext: { workspacePath, filePath: file.path } }
              : {})}
          />
        </div>
      );
    }
    if (isSvg) {
      return <WorkspaceSvgPreview name={file.name} draft={draft} />;
    }
    return null;
  };

  return (
    <div className="workspace-file-browser__preview-body">
      {showModeToggle && (
        <div className="workspace-file-browser__mode-toggle">
          {showModeToggle && (
            <>
              <button
                type="button"
                className={`workspace-file-browser__mode-btn ${viewMode === "preview" ? "is-active" : ""}`}
                onClick={() => setViewMode("preview")}
                title={t("fileBrowser.previewMode")}
              >
                <Eye size={14} />
                <span>{t("fileBrowser.preview")}</span>
              </button>
              <button
                type="button"
                className={`workspace-file-browser__mode-btn ${viewMode === "edit" ? "is-active" : ""}`}
                onClick={() => setViewMode("edit")}
                title={t("fileBrowser.editMode")}
              >
                <Pencil size={14} />
                <span>{t("fileBrowser.edit")}</span>
              </button>
            </>
          )}

        </div>
      )}
      {viewMode === "preview" && (isMarkdown || isSvg) ? (
        renderPreviewContent()
      ) : (
        <Suspense
          fallback={<div className="workspace-file-browser__message">{t("fileBrowser.loadingEditor")}</div>}
        >
          <LazyCodeMirror
            key={`${file.path}:${target?.requestId ?? 0}`}
            content={draft}
            path={file.path}
            readOnly={!editable}
            {...(editable && handleChange ? { onChange: handleChange } : {})}
            {...(editable ? { onSave: () => void handleSave() } : {})}
            {...(targetLine === undefined ? {} : { targetLine })}
            {...(targetColumn === undefined ? {} : { targetColumn })}
          />
        </Suspense>
      )}
      {statusMessage ? (
        <div
          className={[
            "workspace-file-browser__status",
            saveStatus === "error" ? "is-error" : "",
            dirty && saveStatus !== "error" ? "is-dirty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="status"
        >
          {statusMessage}
        </div>
      ) : null}
    </div>
  );
}
