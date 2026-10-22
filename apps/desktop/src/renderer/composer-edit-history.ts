export interface ComposerEditSnapshot {
  value: string;
  start: number;
  end: number;
}

interface ComposerEdit {
  before: ComposerEditSnapshot;
  after: ComposerEditSnapshot;
  inputType: string;
  time: number;
}

/**
 * DOM replacements must not enter Chromium's per-node editing/undo machinery.
 * Keep one history for native typing and our paste/delete transactions so undo
 * cannot replay stale native commands against a replaced DOM. Bound retained
 * text as well as entry count; always allow undoing the most recent large edit.
 */
export class ComposerEditHistory {
  private undoStack: ComposerEdit[] = [];
  private redoStack: ComposerEdit[] = [];
  private canMerge = false;

  constructor(
    private readonly maxChars = 8 * 1024 * 1024,
    private readonly maxEntries = 100,
  ) {}

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.canMerge = false;
  }

  record(
    before: ComposerEditSnapshot,
    after: ComposerEditSnapshot,
    inputType: string,
    time = Date.now(),
  ): void {
    if (before.value === after.value) return;
    const previous = this.undoStack.at(-1);
    const canMerge =
      this.canMerge &&
      previous &&
      (inputType === "insertText" ||
        inputType === "deleteContentBackward" ||
        inputType === "deleteContentForward") &&
      previous.inputType === inputType &&
      time - previous.time < 750 &&
      before.start === before.end &&
      previous.before.start === previous.before.end &&
      previous.after.value === before.value &&
      previous.after.start === before.start &&
      previous.after.end === before.end;
    if (canMerge) {
      previous.after = after;
      previous.time = time;
    } else {
      this.undoStack.push({ before, after, inputType, time });
    }
    this.redoStack = [];
    this.canMerge = true;
    let chars = this.undoStack.reduce(
      (sum, edit) => sum + edit.before.value.length + edit.after.value.length,
      0,
    );
    while (this.undoStack.length > 1 && (chars > this.maxChars || this.undoStack.length > this.maxEntries)) {
      const removed = this.undoStack.shift();
      if (removed) chars -= removed.before.value.length + removed.after.value.length;
    }
  }

  undo(): ComposerEditSnapshot | undefined {
    this.canMerge = false;
    const edit = this.undoStack.pop();
    if (!edit) return undefined;
    this.redoStack.push(edit);
    return edit.before;
  }

  redo(): ComposerEditSnapshot | undefined {
    this.canMerge = false;
    const edit = this.redoStack.pop();
    if (!edit) return undefined;
    this.undoStack.push(edit);
    return edit.after;
  }
}
