import { ComposerReferenceIcon } from "./ComposerReferenceIcon";
import { parsePromptSegments, skillToken } from "./composer-skills";
import { MaterialFileIcon } from "./MaterialFileIcon";
import { dispatchWorkspaceFileReference, workspaceFileReferenceBasename } from "./workspace-file-reference";

/** Render user-prompt text with `@file{abs}` chips; other tokens stay literal. */
export function UserPromptBodyContent({ text }: { text: string }) {
  const segments = parsePromptSegments(text);
  const hasFileChip = segments.some((segment) => segment.type === "file" || segment.type === "reference");
  if (!hasFileChip) {
    return text;
  }
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return <span key={`t-${index}`}>{segment.value}</span>;
        }
        if (segment.type === "skill") {
          return <span key={`s-${index}`}>{skillToken(segment.name)}</span>;
        }
        if (segment.type === "reference") {
          const ref = segment.reference;
          return (
            <span
              key={`r-${index}`}
              className="markdown-file-ref run-log-user-prompt-file-ref composer-reference-display"
              title={`${ref.label} · ${ref.detail}`}
            >
              <ComposerReferenceIcon reference={ref} size={14} />
              <span>@{ref.label}</span>
            </span>
          );
        }
        const label = workspaceFileReferenceBasename(segment.path);
        return (
          <button
            key={`f-${index}-${segment.path}`}
            type="button"
            className="markdown-file-ref run-log-user-prompt-file-ref"
            title={segment.path}
            onClick={() => dispatchWorkspaceFileReference({ path: segment.path })}
          >
            <MaterialFileIcon path={segment.path} size={14} className="markdown-file-ref__icon" />
            <span className="markdown-file-ref__label">{label}</span>
          </button>
        );
      })}
    </>
  );
}
