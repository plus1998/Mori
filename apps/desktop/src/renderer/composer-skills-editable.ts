import { composerReferenceIconNodes, composerReferenceTitle } from "./composer-reference-presentation";
import { composerReferenceToken, type ComposerReference } from "../shared/composer-references";
import { i18n } from "./i18n";
import type { SkillInfo } from "../shared/skills";
import { getMaterialIconUrl, resolveMaterialIconName } from "./material-file-icon";
import { formatSkillDisplayName, parsePromptSegments, skillToken } from "./composer-skills";
import { fileAttachmentToken, workspaceFileReferenceBasename } from "./workspace-file-reference";

const SKILL_SELECTOR = "[data-skill]";
const FILE_SELECTOR = "[data-file-path]";
const REFERENCE_SELECTOR = "[data-reference-token]";
function isReferenceElement(node: ChildNode): boolean { return node instanceof HTMLElement && node.matches(REFERENCE_SELECTOR); }
function isReferenceOrFileElement(node: ChildNode): node is HTMLElement { return isFileElement(node) || isReferenceElement(node); }

function isBlockElement(node: ChildNode): node is HTMLElement {
  return node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P");
}

function isEmptyBlock(node: Node): boolean {
  return node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P") &&
    node.childNodes.length === 1 && node.firstChild instanceof HTMLElement && node.firstChild.tagName === "BR";
}

function isSkillElement(node: ChildNode): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(SKILL_SELECTOR);
}

function isFileElement(node: ChildNode): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(FILE_SELECTOR);
}

function isAtomicChipElement(node: ChildNode): node is HTMLElement {
  return isSkillElement(node) || isReferenceOrFileElement(node);
}

type EditableChildRange = {
  node: ChildNode;
  start: number;
  end: number;
};

function chipRanges(root: HTMLElement): EditableChildRange[] {
  const ranges: EditableChildRange[] = [];
  function visit(parent: Node, start: number): number {
    if (isEmptyBlock(parent)) return start;
    let offset = start;
    const children = parent.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (index > 0 && needsBlockSeparator(children[index - 1]!, child)) offset += 1;
      if (isAtomicChipElement(child)) {
        const end = offset + serializedLength(child);
        ranges.push({ node: child, start: offset, end });
        offset = end;
      } else if (child instanceof HTMLElement && child.tagName !== "BR") {
        offset = visit(child, offset);
      } else {
        offset += serializedLength(child);
      }
    }
    return offset;
  }
  visit(root, 0);
  return ranges;
}

function skillTokenLength(node: HTMLElement): number {
  const name = node.dataset.skill;
  return name ? skillToken(name).length : 0;
}

function fileTokenLength(node: HTMLElement): number {
  const path = node.dataset.filePath;
  return path ? fileAttachmentToken(path).length : 0;
}

function needsBlockSeparator(prev: ChildNode, next: ChildNode): boolean {
  return isBlockElement(prev) || isBlockElement(next);
}

function serializeChildren(parent: Node): string {
  const children = [...parent.childNodes];
  let out = "";
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]!;
    if (index > 0 && needsBlockSeparator(children[index - 1]!, node)) {
      out += "\n";
    }
    out += serializeNode(node);
  }
  return out;
}

export function serializeEditable(root: HTMLElement): string {
  const out = serializeChildren(root);
  // Chromium keeps a lone <br> in an empty contenteditable; treat that as blank.
  if (
    out === "\n" &&
    root.childNodes.length === 1 &&
    root.firstChild instanceof HTMLElement &&
    root.firstChild.tagName === "BR"
  ) {
    return "";
  }
  return out;
}

function serializeNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (node.tagName === "BR") {
    return "\n";
  }
  if (isReferenceElement(node)) return node.dataset.referenceToken ?? "";
  if (isSkillElement(node)) {
    return skillToken(node.dataset.skill!);
  }
  if (isFileElement(node)) {
    const filePath = (node as HTMLElement).dataset.filePath;
    return filePath ? fileAttachmentToken(filePath) : "";
  }
  if (isBlockElement(node)) {
    return isEmptyBlock(node) ? "" : serializeChildren(node);
  }
  return serializeChildren(node);
}

function serializedLength(node: ChildNode): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").length;
  }
  if (!(node instanceof HTMLElement)) {
    return 0;
  }
  if (node.tagName === "BR") {
    return 1;
  }
  if (isReferenceElement(node)) return (node.dataset.referenceToken ?? "").length;
  if (isSkillElement(node)) {
    return skillTokenLength(node);
  }
  if (isFileElement(node)) {
    return fileTokenLength(node);
  }
  if (isEmptyBlock(node)) return 0;
  const element = node as HTMLElement;
  const children = [...element.childNodes];
  let length = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (index > 0 && needsBlockSeparator(children[index - 1]!, child)) {
      length += 1;
    }
    length += serializedLength(child);
  }
  return length;
}

function sumChildLengths(parent: Node, childIndex: number): number {
  if (isEmptyBlock(parent)) return 0;
  let length = 0;
  const children = parent.childNodes;
  for (let index = 0; index < childIndex && index < children.length; index += 1) {
    const child = children[index]!;
    if (index > 0 && needsBlockSeparator(children[index - 1]!, child)) {
      length += 1;
    }
    length += serializedLength(child);
  }
  return length;
}

export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { start: 0, end: 0 };
  }
  return {
    start: measureOffset(root, selection.anchorNode, selection.anchorOffset),
    end: measureOffset(root, selection.focusNode, selection.focusOffset),
  };
}

export function getCursorOffset(root: HTMLElement): number {
  return getSelectionOffsets(root).end;
}

function measureOffset(container: Node, targetNode: Node | null, targetOffset: number): number {
  if (!targetNode) {
    return 0;
  }
  if (container === targetNode) {
    return sumChildLengths(container, targetOffset);
  }

  let offset = 0;
  const children = container.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (index > 0 && needsBlockSeparator(children[index - 1]!, child)) {
      offset += 1;
    }
    if (child === targetNode) {
      if (child.nodeType === Node.TEXT_NODE) {
        return offset + targetOffset;
      }
      return offset + sumChildLengths(child, targetOffset);
    }
    if (child.contains(targetNode)) {
      return offset + measureOffset(child, targetNode, targetOffset);
    }
    offset += serializedLength(child);
  }
  return offset;
}

export function setCursorOffset(root: HTMLElement, offset: number): void {
  setSelectionOffsets(root, offset, offset);
}

/**
 * Place the caret at a viewport point inside `root`. A right-click that arrives while the
 * document selection lives elsewhere uses this so Paste lands where the pointer aimed.
 * Returns false when the point resolves outside the editor.
 */
export function setSelectionAtPoint(root: HTMLElement, x: number, y: number): boolean {
  const position = document.caretPositionFromPoint?.(x, y);
  if (!position || !root.contains(position.offsetNode)) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection) {
    return false;
  }
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function setSelectionOffsets(root: HTMLElement, start: number, end: number): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const startPos = locatePosition(root, start);
  const endPos = locatePosition(root, end);
  if (!startPos || !endPos) {
    return;
  }
  selection.setBaseAndExtent(startPos.node, startPos.offset, endPos.node, endPos.offset);
}

export function handleFileChipDeletion(
  root: HTMLElement,
  direction: "backward" | "forward",
): "selected" | "deleted" | null {
  if (!root.querySelector(`${FILE_SELECTOR}, ${REFERENCE_SELECTOR}`)) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const selectionNodes = [selection.anchorNode, selection.focusNode];
  if (
    selectionNodes.some((node) => !node || (node !== root && !root.contains(node)))
  ) {
    return null;
  }

  const offsets = getSelectionOffsets(root);
  const start = Math.min(offsets.start, offsets.end);
  const end = Math.max(offsets.start, offsets.end);
  const serialized = serializeEditable(root);
  const ranges = chipRanges(root);

  if (start !== end) {
    const selectedFile = ranges.find(
      ({ node, start: chipStart, end: chipEnd }) =>
        isReferenceOrFileElement(node) &&
        start === chipStart &&
        end >= chipEnd &&
        end <= serialized.length &&
        serialized.slice(chipEnd, end).trim() === "",
    );
    if (!selectedFile) {
      return null;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return "deleted";
  }

  const adjacentFile = [...ranges]
    .reverse()
    .find(({ node, start: chipStart, end: chipEnd }) => {
      if (!isReferenceOrFileElement(node)) {
        return false;
      }
      if (direction === "forward") {
        return start === chipStart;
      }
      return start === chipEnd ||
        (start > chipEnd && serialized.slice(chipEnd, start).trim() === "");
    });
  if (!adjacentFile) {
    return null;
  }

  const selectionEnd = direction === "backward" ? start : adjacentFile.end;
  setSelectionOffsets(root, adjacentFile.start, selectionEnd);
  return "selected";
}

function locatePosition(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  return locateInParent(root, target);
}

function locateInParent(parent: Node, target: number): { node: Node; offset: number } | null {
  if (isEmptyBlock(parent)) return { node: parent, offset: 0 };
  let remaining = target;
  const children = parent.childNodes;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (index > 0 && needsBlockSeparator(children[index - 1]!, child)) {
      if (remaining === 0) {
        return { node: parent, offset: index };
      }
      remaining -= 1;
    }

    const childLength = serializedLength(child);
    if (remaining <= childLength) {
      if (child.nodeType === Node.TEXT_NODE) {
        return { node: child, offset: remaining };
      }
      if (child instanceof HTMLElement && child.tagName === "BR") {
        return remaining === 0 ? { node: parent, offset: index } : { node: parent, offset: index + 1 };
      }
      if (isAtomicChipElement(child)) {
        return remaining === 0 ? { node: parent, offset: index } : { node: parent, offset: index + 1 };
      }
      const nested = locateInParent(child, remaining);
      if (nested) {
        return nested;
      }
    }
    remaining -= childLength;
  }

  return { node: parent, offset: children.length };
}

const SKILL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';

function appendSkillChip(
  root: HTMLElement,
  name: string,
  skillsByName: ReadonlyMap<string, SkillInfo>,
): void {
  const skill = skillsByName.get(name);
  const span = document.createElement("span");
  span.className = "composer-skill-inline";
  span.contentEditable = "false";
  span.dataset.skill = name;
  if (skill?.description) {
    span.title = skill.description;
  }
  const icon = document.createElement("span");
  icon.className = "composer-skill-inline-icon";
  icon.innerHTML = SKILL_ICON_SVG;
  const label = document.createElement("span");
  label.className = "composer-skill-inline-label";
  label.textContent = formatSkillDisplayName(name, skill);
  span.append(icon, label);
  root.appendChild(span);
}

function appendFileChip(root: HTMLElement, path: string): void {
  const span = document.createElement("span");
  span.className = "composer-file-inline";
  span.contentEditable = "false";
  span.dataset.filePath = path;
  span.title = path;
  const icon = document.createElement("img");
  icon.className = "composer-file-inline-icon";
  icon.src = getMaterialIconUrl(resolveMaterialIconName(path));
  icon.alt = "";
  icon.width = 14;
  icon.height = 14;
  icon.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "composer-file-inline-label";
  label.textContent = workspaceFileReferenceBasename(path);
  span.append(icon, label);
  root.appendChild(span);
}

function appendReferenceChip(root: HTMLElement, reference: ComposerReference): void {
  const span = document.createElement("span");
  span.className = "composer-file-inline composer-reference-inline";
  span.contentEditable = "false";
  span.dataset.referenceToken = composerReferenceToken(reference);
  span.dataset.referenceKind = reference.kind;
  span.dataset.referenceId = reference.id;
  span.title = composerReferenceTitle(reference);
  const icon = document.createElement("span");
  icon.className = "composer-reference-inline-icon";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.65", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(name, value);
  for (const [tag, attributes] of composerReferenceIconNodes(reference)) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  icon.append(svg);
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement(reference.kind === "web_selection" ? "button" : "span");
  label.className = "composer-reference-inline-label";
  if (reference.kind === "web_selection") {
    (label as HTMLButtonElement).type = "button";
    label.classList.add("composer-reference-open");
  }
  const at = document.createElement("span");
  at.className = "composer-reference-at";
  at.textContent = "@";
  label.append(at, reference.label);
  span.append(icon, label);
  if (reference.kind === "web_selection") {
    span.classList.add("composer-browser-selection");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-reference-remove";
    remove.dataset.referenceRemove = "true";
    remove.setAttribute("aria-label", i18n.t("browser.selection.remove"));
    remove.textContent = "×";
    span.append(remove);
  }
  root.appendChild(span);
}

const textGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function appendEditableText(parent: HTMLElement, value: string): void {
  if (value.length < 8192) {
    parent.appendChild(document.createTextNode(value));
    return;
  }
  // Independent inline formatting contexts bound shaping/line-breaking memory
  // even for a pasted paragraph with no newlines. These spans add no characters
  // or block separators to the selection/serialized prompt.
  const graphemes = textGraphemes.segment(value);
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 2048, value.length);
    if (end < value.length) {
      const boundary = graphemes.containing(end)!;
      end = boundary.index > start ? boundary.index : boundary.index + boundary.segment.length;
    }
    const span = document.createElement("span");
    span.style.display = "inline-block";
    span.style.maxWidth = "100%";
    span.style.verticalAlign = "top";
    span.textContent = value.slice(start, end);
    parent.appendChild(span);
    start = end;
  }
}

export function renderEditablePrompt(
  root: HTMLElement,
  text: string,
  skillsByName: ReadonlyMap<string, SkillInfo>,
): void {
  root.replaceChildren();
  if (!text) {
    return;
  }
  // Huge inline formatting contexts trigger costly Chromium line layout.
  // Keep large multiline drafts in independent blocks, without changing text.
  const useLines = text.length >= 16_384 && text.includes("\n");
  const appendLine = () => {
    const line = document.createElement("div");
    line.style.minHeight = "1lh";
    root.appendChild(line);
    return line;
  };
  let parent = useLines ? appendLine() : root;
  for (const segment of parsePromptSegments(text)) {
    if (segment.type === "text") {
      if (useLines) {
        const lines = segment.value.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) parent = appendLine();
          if (lines[index]) appendEditableText(parent, lines[index]!);
        }
      } else {
        appendEditableText(parent, segment.value);
      }
      continue;
    }
    if (segment.type === "skill") {
      appendSkillChip(parent, segment.name, skillsByName);
      continue;
    }
    if (segment.type === "reference") appendReferenceChip(parent, segment.reference);
    else appendFileChip(parent, segment.path);
  }
}
