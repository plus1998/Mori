import { shortcutMatches } from "./keyboard-shortcuts";
import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { parsePromptSegments } from "./composer-skills";
import type { SkillInfo } from "../shared/skills";
import { ComposerContextMenu, type ComposerContextMenuAnchor } from "./ComposerContextMenu";
import { copyTextToClipboard } from "./clipboard";
import { readComposerClipboard } from "./composer-clipboard-paste";
import { previewBrowserSelection } from "./browser-selection-events";
import { ComposerEditHistory, type ComposerEditSnapshot } from "./composer-edit-history";
import {
  getCursorOffset,
  getSelectionOffsets,
  handleFileChipDeletion,
  renderEditablePrompt,
  serializeEditable,
  setSelectionAtPoint,
  setSelectionOffsets,
} from "./composer-skills-editable";

export interface ComposerSkillsInputHandle {
  focus: () => void;
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  getSelectionStart: () => number;
  getSelectionEnd: () => number;
  setCursor: (offset: number) => void;
  setSelection: (start: number, end: number) => void;
  insertNewline: () => void;
  fitHeight: () => void;
}

interface ComposerSkillsInputProps {
  value: string;
  referencePopup?: { activeIndex: number } | undefined;
  onChange: (value: string) => void;
  skillsByName: ReadonlyMap<string, SkillInfo>;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  maxHeight?: number | undefined;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /** Clipboard images pasted through the right-click menu (Cmd+V images arrive via `onPaste`). */
  onPasteImageFiles?: (files: File[]) => void;
  onCursorChange?: (cursor: number) => void;
}

export const ComposerSkillsInput = forwardRef<ComposerSkillsInputHandle, ComposerSkillsInputProps>(
  function ComposerSkillsInput(
    {
      value,
      referencePopup,
      onChange,
      skillsByName,
      disabled,
      placeholder,
      maxHeight = 200,
      onKeyDown,
      onPaste,
      onPasteImageFiles,
      onCursorChange,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const isComposingRef = useRef(false);
    const lastEmittedValueRef = useRef(value);
    const historyRef = useRef(new ComposerEditHistory());
    const pendingEditRef = useRef<{ before: ComposerEditSnapshot; inputType: string } | null>(null);
    const skillsByNameRef = useRef(skillsByName);
    skillsByNameRef.current = skillsByName;
    const [contextMenu, setContextMenu] = useState<ComposerContextMenuAnchor | undefined>(undefined);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const syncReferenceSelection = () => {
        const selection = window.getSelection();
        const range = selection?.rangeCount && !selection.isCollapsed &&
          editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
          ? selection.getRangeAt(0) : undefined;
        for (const chip of editor.querySelectorAll("[data-reference-token]")) {
          chip.classList.toggle("is-selected", Boolean(range?.intersectsNode(chip)));
        }
      };
      document.addEventListener("selectionchange", syncReferenceSelection);
      return () => document.removeEventListener("selectionchange", syncReferenceSelection);
    }, []);

    const fitHeight = useCallback(
      (editor: HTMLDivElement) => {
        // A contenteditable div can size to its content without a measurement
        // pass. Collapsing it first temporarily expands the sibling Feed and
        // clamps its scrollTop, even when the final editor height is unchanged.
        editor.style.height = "auto";
        editor.style.maxHeight = `${maxHeight}px`;
        editor.style.overflowY = "auto";
      },
      [maxHeight],
    );

    const commitEditorValue = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      const next = serializeEditable(editor);
      const needsChipUpgrade =
        parsePromptSegments(next).filter(segment => segment.type !== "text").length >
        editor.querySelectorAll("[data-skill], [data-file-path], [data-reference-token]").length;
      if (needsChipUpgrade) {
        const cursor = getCursorOffset(editor);
        renderEditablePrompt(editor, next, skillsByNameRef.current);
        setSelectionOffsets(editor, cursor, cursor);
      }
      const selection = getSelectionOffsets(editor);
      const pending = pendingEditRef.current;
      pendingEditRef.current = null;
      historyRef.current.record(
        pending?.before ?? { value: lastEmittedValueRef.current, ...selection },
        { value: next, ...selection },
        pending?.inputType ?? "insertReplacementText",
      );
      lastEmittedValueRef.current = next;
      onChange(next);
      onCursorChange?.(selection.end);
      fitHeight(editor);
    }, [onChange, onCursorChange, fitHeight]);

    const captureEdit = useCallback((inputType: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      pendingEditRef.current = {
        before: { value: lastEmittedValueRef.current, ...getSelectionOffsets(editor) },
        inputType,
      };
    }, []);

    const restoreHistory = useCallback((direction: "undo" | "redo") => {
      const editor = editorRef.current;
      if (!editor) return;
      const snapshot = historyRef.current[direction]();
      if (!snapshot) return;
      pendingEditRef.current = null;
      renderEditablePrompt(editor, snapshot.value, skillsByNameRef.current);
      setSelectionOffsets(editor, snapshot.start, snapshot.end);
      lastEmittedValueRef.current = snapshot.value;
      onChange(snapshot.value);
      onCursorChange?.(snapshot.end);
      fitHeight(editor);
    }, [onChange, onCursorChange, fitHeight]);

    const replaceSelectedText = useCallback((text: string, inputType: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      captureEdit(inputType);
      const { before } = pendingEditRef.current!;
      const start = Math.min(before.start, before.end);
      const end = Math.max(before.start, before.end);
      const next = before.value.slice(0, start) + text + before.value.slice(end);
      // Native selected deletion builds an editing command for every DOM node.
      // Replace the model once instead, including paste/cut over a large selection.
      renderEditablePrompt(editor, next, skillsByNameRef.current);
      setSelectionOffsets(editor, start + text.length, start + text.length);
      commitEditorValue();
    }, [captureEdit, commitEditorValue]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const beforeInput = (event: InputEvent) => {
        if (disabled || isComposingRef.current || event.isComposing) return;
        if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
          event.preventDefault();
          restoreHistory(event.inputType === "historyUndo" ? "undo" : "redo");
          return;
        }
        const selection = window.getSelection();
        if (event.cancelable && selection && !selection.isCollapsed &&
          editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
          const replacement = event.inputType.startsWith("delete") ? "" :
            event.inputType === "insertParagraph" || event.inputType === "insertLineBreak" ? "\n" :
            event.inputType === "insertText" || event.inputType === "insertReplacementText" ? event.data : null;
          if (replacement !== null) {
            event.preventDefault();
            replaceSelectedText(replacement, event.inputType);
            return;
          }
        }
        captureEdit(event.inputType);
      };
      editor.addEventListener("beforeinput", beforeInput);
      return () => editor.removeEventListener("beforeinput", beforeInput);
    }, [captureEdit, replaceSelectedText, restoreHistory, disabled]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editorRef.current?.focus(),
        scrollIntoView: (options) => editorRef.current?.scrollIntoView(options),
        getSelectionStart: () => (editorRef.current ? getSelectionOffsets(editorRef.current).start : 0),
        getSelectionEnd: () => (editorRef.current ? getCursorOffset(editorRef.current) : 0),
        setCursor: (offset) => {
          if (editorRef.current) {
            setSelectionOffsets(editorRef.current, offset, offset);
          }
        },
        setSelection: (start, end) => {
          if (editorRef.current) {
            setSelectionOffsets(editorRef.current, start, end);
          }
        },
        insertNewline: () => {
          if (isComposingRef.current) {
            return;
          }
          replaceSelectedText("\n", "insertLineBreak");
        },
        fitHeight: () => {
          if (editorRef.current) {
            fitHeight(editorRef.current);
          }
        },
      }),
      [replaceSelectedText, fitHeight],
    );

    const syncDomFromValue = useCallback(
      (restoreCursor: boolean) => {
        const editor = editorRef.current;
        if (!editor || isComposingRef.current) {
          return;
        }
        const serialized = serializeEditable(editor);
        const hasChipTokens = parsePromptSegments(value).some(segment => segment.type !== "text");
        const domHasChips = Boolean(editor.querySelector("[data-skill], [data-file-path], [data-reference-token]"));
        // Plain-text token strings can serialize equal to `value` while chips are
        // still missing (e.g. Playwright fill / paste of `@file{...}`).
        if (serialized === value && !(hasChipTokens && !domHasChips)) {
          return;
        }
        const selection = restoreCursor ? getSelectionOffsets(editor) : null;
        renderEditablePrompt(editor, value, skillsByNameRef.current);
        if (selection) {
          const nextStart = Math.min(selection.start, value.length);
          const nextEnd = Math.min(selection.end, value.length);
          setSelectionOffsets(editor, nextStart, nextEnd);
        }
      },
      [value],
    );

    useLayoutEffect(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      const isExternalUpdate = value !== lastEmittedValueRef.current;
      if (isExternalUpdate) {
        historyRef.current.clear();
        pendingEditRef.current = null;
      }
      syncDomFromValue(!isExternalUpdate);
      lastEmittedValueRef.current = value;
      fitHeight(editor);
    }, [value, fitHeight, syncDomFromValue]);

    useLayoutEffect(() => {
      const editor = editorRef.current;
      if (
        !editor ||
        isComposingRef.current ||
        !parsePromptSegments(value).some(segment => segment.type !== "text")
      ) {
        return;
      }
      if (serializeEditable(editor) !== value) {
        return;
      }
      const { start, end } = getSelectionOffsets(editor);
      renderEditablePrompt(editor, value, skillsByNameRef.current);
      setSelectionOffsets(editor, start, end);
    }, [skillsByName]);

    const handleInput = () => {
      if (isComposingRef.current) {
        const editor = editorRef.current;
        if (editor) {
          fitHeight(editor);
        }
        return;
      }
      commitEditorValue();
    };

    const handleCompositionStart = () => {
      captureEdit("insertCompositionText");
      isComposingRef.current = true;
    };

    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      commitEditorValue();
    };

    const syncCursor = () => {
      if (isComposingRef.current) {
        return;
      }
      const editor = editorRef.current;
      if (editor) {
        onCursorChange?.(getCursorOffset(editor));
      }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        disabled ||
        isComposingRef.current ||
        event.nativeEvent.isComposing ||
        event.key === "Process" ||
        event.keyCode === 229
      ) {
        return;
      }
      const referenceButton = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-reference-kind="web_selection"] button') : null;
      if (referenceButton && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        referenceButton.click();
        return;
      }
      const editor = editorRef.current;
      if (editor && shortcutMatches(event, "selectAll")) {
        event.preventDefault();
        // Chromium's visual select-all can omit an otherwise blank/trailing newline.
        const length = serializeEditable(editor).length;
        setSelectionOffsets(editor, 0, length);
        onCursorChange?.(length);
        return;
      }
      if (shortcutMatches(event, "undo") || shortcutMatches(event, "redo")) {
        event.preventDefault();
        restoreHistory(shortcutMatches(event, "redo") ? "redo" : "undo");
        return;
      }
      if (editor && (event.key === "Backspace" || event.key === "Delete")) {
        captureEdit(event.key === "Backspace" ? "deleteContentBackward" : "deleteContentForward");
        const deletion = handleFileChipDeletion(
          editor,
          event.key === "Backspace" ? "backward" : "forward",
        );
        if (deletion) {
          event.preventDefault();
          if (deletion === "deleted") {
            commitEditorValue();
          }
          return;
        }
      }
      onKeyDown?.(event);
    };

    const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
      if (onPaste) {
        onPaste(event);
        if (event.defaultPrevented) {
          return;
        }
      }
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      event.preventDefault();
      replaceSelectedText(text, "insertFromPaste");
    };

    /**
     * Right-click opens Eco's own menu. Electron renders no native menu for the renderer, and
     * Chromium's built-in one cannot act on this contentEditable, so without it the Composer has
     * no pointer route to cut / copy / paste / select-all.
     */
    const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
      const editor = editorRef.current;
      if (!editor || disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selection = window.getSelection();
      const anchorNode = selection?.anchorNode ?? null;
      const focusNode = selection?.focusNode ?? null;
      const inEditor =
        anchorNode !== null &&
        focusNode !== null &&
        editor.contains(anchorNode) &&
        editor.contains(focusNode);
      let start = 0;
      let end = 0;
      let selectedText = "";
      if (inEditor) {
        ({ start, end } = getSelectionOffsets(editor));
        selectedText = selection?.toString() ?? "";
      } else {
        // The pointer is in the Composer but the document selection is not (first right-click,
        // or text selected in the Feed): aim the caret at the pointer instead of the stale range.
        editor.focus();
        if (!setSelectionAtPoint(editor, event.clientX, event.clientY)) {
          const length = serializeEditable(editor).length;
          setSelectionOffsets(editor, length, length);
        }
        ({ start, end } = getSelectionOffsets(editor));
      }
      setContextMenu({ x: event.clientX, y: event.clientY, start, end, selectedText });
    };

    const closeContextMenu = useCallback(() => {
      setContextMenu(undefined);
    }, []);

    /** Re-apply the selection captured at right-click: the menu button took focus meanwhile. */
    const replaceSelection = (anchor: ComposerContextMenuAnchor, text: string) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      editor.focus();
      setSelectionOffsets(editor, anchor.start, anchor.end);
      replaceSelectedText(text, text ? "insertFromPaste" : "deleteByCut");
    };

    const handleContextMenuCut = () => {
      const anchor = contextMenu;
      closeContextMenu();
      if (!anchor?.selectedText) {
        return;
      }
      void copyTextToClipboard(anchor.selectedText);
      replaceSelection(anchor, "");
    };

    const handleContextMenuCopy = () => {
      const anchor = contextMenu;
      closeContextMenu();
      if (!anchor?.selectedText) {
        return;
      }
      void copyTextToClipboard(anchor.selectedText);
      editorRef.current?.focus();
    };

    const handleContextMenuPaste = () => {
      const anchor = contextMenu;
      closeContextMenu();
      if (!anchor) {
        return;
      }
      void (async () => {
        const content = await readComposerClipboard(window.eco);
        if (!content) {
          editorRef.current?.focus();
          return;
        }
        if (content.kind === "image") {
          onPasteImageFiles?.([content.file]);
          editorRef.current?.focus();
          return;
        }
        replaceSelection(anchor, content.text);
      })();
    };

    const handleContextMenuSelectAll = () => {
      const editor = editorRef.current;
      closeContextMenu();
      if (!editor) {
        return;
      }
      editor.focus();
      setSelectionOffsets(editor, 0, serializeEditable(editor).length);
      syncCursor();
    };

    return (
      <div className="composer-skill-input">
        <div
          ref={editorRef}
          className="composer-skill-input-control"
          contentEditable={disabled ? false : true}
          suppressContentEditableWarning
          aria-autocomplete={referencePopup ? "list" : undefined}
          aria-expanded={referencePopup ? true : undefined}
          aria-controls={referencePopup ? "composer-references-listbox" : undefined}
          aria-activedescendant={referencePopup && referencePopup.activeIndex >= 0 ? `composer-reference-option-${referencePopup.activeIndex}` : undefined}
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          spellCheck={false}
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onClick={event => {
            const target = event.target instanceof Element ? event.target : null;
            const chip = target?.closest<HTMLElement>('[data-reference-kind="web_selection"]');
            if (chip && editorRef.current?.contains(chip)) {
              if (target?.closest("[data-reference-remove]")) {
                if (!disabled) { captureEdit("deleteContent"); chip.remove(); commitEditorValue(); }
              }
              else if (chip.dataset.referenceId) previewBrowserSelection(chip.dataset.referenceId);
              return;
            }
            syncCursor();
          }}
          onKeyUp={syncCursor}
          onPaste={handlePaste}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
        />
        {contextMenu ? (
          <ComposerContextMenu
            anchor={contextMenu}
            hasSelection={contextMenu.start !== contextMenu.end}
            onCut={handleContextMenuCut}
            onCopy={handleContextMenuCopy}
            onPaste={handleContextMenuPaste}
            onSelectAll={handleContextMenuSelectAll}
            onClose={closeContextMenu}
          />
        ) : null}
      </div>
    );
  },
);
