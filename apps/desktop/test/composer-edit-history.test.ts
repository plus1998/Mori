import { expect, test } from "bun:test";
import { ComposerEditHistory, type ComposerEditSnapshot } from "../src/renderer/composer-edit-history";

const snapshot = (value: string, start = value.length, end = start): ComposerEditSnapshot => ({
  value,
  start,
  end,
});

test("large paste, reversed selection deletion, typing, undo and redo share one history", () => {
  const history = new ComposerEditHistory();
  const text = "draft\n".repeat(100_000);
  history.record(snapshot(""), snapshot(text), "insertFromPaste");
  history.record(snapshot(text, text.length, 0), snapshot(""), "deleteContentBackward");
  history.record(snapshot(""), snapshot("a"), "insertText");
  history.record(snapshot("a"), snapshot("ab"), "insertText");
  expect(history.undo()).toEqual(snapshot(""));
  expect(history.undo()).toEqual(snapshot(text, text.length, 0));
  expect(history.redo()).toEqual(snapshot(""));
  expect(history.redo()).toEqual(snapshot("ab"));
  history.undo();
  history.undo();
  expect(history.undo()).toEqual(snapshot(""));
});

test("typing at a moved caret and typing after a pause form separate edits", () => {
  const history = new ComposerEditHistory();
  history.record(snapshot(""), snapshot("a"), "insertText", 0);
  history.record(snapshot("a", 0), snapshot("ba", 1), "insertText", 10);
  history.record(snapshot("ba", 1), snapshot("bca", 2), "insertText", 1000);
  expect(history.undo()).toEqual(snapshot("ba", 1));
  expect(history.undo()).toEqual(snapshot("a", 0));
  expect(history.undo()).toEqual(snapshot(""));
});

test("typing after replacing a selection can be undone before the replacement", () => {
  const history = new ComposerEditHistory();
  history.record(snapshot("draft", 0, 5), snapshot("x"), "insertText", 0);
  history.record(snapshot("x"), snapshot("xy"), "insertText", 10);
  history.record(snapshot("xy"), snapshot("xyz"), "insertText", 20);
  expect(history.undo()).toEqual(snapshot("x"));
  expect(history.undo()).toEqual(snapshot("draft", 0, 5));
});

test("history limits retained large snapshots while keeping the latest oversized edit undoable", () => {
  const history = new ComposerEditHistory(20, 100);
  history.record(snapshot(""), snapshot("one"), "insertFromPaste");
  history.record(snapshot("one"), snapshot("two"), "insertFromPaste");
  history.record(snapshot("two"), snapshot("x".repeat(100)), "insertFromPaste");
  expect(history.undo()).toEqual(snapshot("two"));
  expect(history.undo()).toBeUndefined();
  expect(history.redo()).toEqual(snapshot("x".repeat(100)));
});

test("an edit after undo drops redo; switching drafts clears both stacks", () => {
  const history = new ComposerEditHistory();
  history.record(snapshot("old"), snapshot("new"), "insertFromPaste");
  history.undo();
  history.record(snapshot("old"), snapshot("other"), "insertFromPaste");
  expect(history.redo()).toBeUndefined();
  history.clear();
  expect(history.undo()).toBeUndefined();
  expect(history.redo()).toBeUndefined();
});
