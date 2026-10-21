import { useCallback, useEffect, useMemo, useState } from "react";
import type { Plugin as PMPlugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  collectLocalImageSrcs,
  resolveLocalImageDataUrls,
  rewriteLocalImageSrcs,
  type MarkdownLocalImageContext,
} from "./markdown-local-images";
import {
  createFeedMarkdownDoc,
  FEED_MARKDOWN_PLUGINS,
  feedMarkdownSchema,
  renderFeedMarkdownHtml,
} from "./prosemirror/feed-markdown";
import { EMPTY_PM_PLUGINS, ProseMirrorHost, type ProseMirrorDocProvider } from "./prosemirror/ProseMirrorHost";

interface MarkdownContentProps {
  text: string;
  className?: string;
  /** When set, relative / workspace-local image srcs are loaded via readWorkspaceFile. */
  localImageContext?: MarkdownLocalImageContext;
  /** Replaces the default feed plugin list (e.g. to add a caret decoration). */
  plugins?: readonly PMPlugin[];
  /** Builds the document incrementally instead of re-parsing `text`. */
  docProvider?: ProseMirrorDocProvider;
  /** Receives the editor view, e.g. so a controller can drive decorations. */
  onView?: (view: EditorView | null) => void;
}

function canUseProseMirrorHost(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function MarkdownContent({
  text,
  className,
  localImageContext,
  plugins,
  docProvider,
  onView,
}: MarkdownContentProps) {
  if (!text.trim()) {
    return null;
  }

  const rootClass = className ? `markdown-content ${className}` : "markdown-content";

  // SSR / renderToStaticMarkup (tests): emit HTML from the same PM document model.
  if (!canUseProseMirrorHost()) {
    return <div className={rootClass} dangerouslySetInnerHTML={{ __html: renderFeedMarkdownHtml(text) }} />;
  }

  return (
    <MarkdownContentProseMirror
      text={text}
      className={rootClass}
      {...(localImageContext ? { localImageContext } : {})}
      {...(plugins ? { plugins } : {})}
      {...(docProvider ? { docProvider } : {})}
      {...(onView ? { onView } : {})}
    />
  );
}

function MarkdownContentProseMirror({
  text,
  className,
  localImageContext,
  plugins: pluginsOverride,
  docProvider,
  onView,
}: {
  text: string;
  className: string;
  localImageContext?: MarkdownLocalImageContext;
  plugins?: readonly PMPlugin[];
  docProvider?: ProseMirrorDocProvider;
  onView?: (view: EditorView | null) => void;
}) {
  const plugins = useMemo(() => pluginsOverride ?? FEED_MARKDOWN_PLUGINS, [pluginsOverride]);
  const serializeDoc = useMemo(() => () => "__feed_markdown__", []);
  const [urlBySrc, setUrlBySrc] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [imageEpoch, setImageEpoch] = useState(0);

  useEffect(() => {
    if (!localImageContext?.workspacePath || !localImageContext.filePath) {
      setUrlBySrc(new Map());
      return;
    }

    const api = window.eco as
      | {
          readWorkspaceFile?(input: {
            workspacePath: string;
            filePath: string;
          }): Promise<{
            kind: string;
            mimeType?: string;
            base64?: string;
            url?: string;
            content?: string;
          }>;
        }
      | undefined;
    if (!api?.readWorkspaceFile) {
      setUrlBySrc(new Map());
      return;
    }

    let cancelled = false;
    const doc = createFeedMarkdownDoc(text);
    const srcs = collectLocalImageSrcs(doc);
    if (srcs.length === 0) {
      setUrlBySrc(new Map());
      return;
    }

    void resolveLocalImageDataUrls({
      workspacePath: localImageContext.workspacePath,
      markdownFilePath: localImageContext.filePath,
      srcs,
      readFile: (request) => api.readWorkspaceFile!(request),
    }).then((map) => {
      if (cancelled) return;
      setUrlBySrc(map);
      setImageEpoch((value) => value + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [text, localImageContext?.workspacePath, localImageContext?.filePath]);

  const createDoc = useCallback(
    (value: string) => {
      const doc = createFeedMarkdownDoc(value);
      return rewriteLocalImageSrcs(doc, urlBySrc);
    },
    [urlBySrc],
  );

  return (
    <div className={className}>
      <ProseMirrorHost
        key={`md-images:${imageEpoch}`}
        className="pm-feed-markdown"
        schema={feedMarkdownSchema}
        plugins={plugins.length > 0 ? plugins : EMPTY_PM_PLUGINS}
        content={text}
        createDoc={createDoc}
        serializeDoc={serializeDoc}
        readOnly
        editable={false}
        {...(docProvider ? { docProvider } : {})}
        {...(onView ? { onView } : {})}
      />
    </div>
  );
}
