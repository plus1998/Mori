/** Keep this conversion aligned with Mobile's markdown_to_speech_text.dart. */
export function markdownToSpeechText(markdown: string, codeBlockOmitted = "代码块已省略"): string {
  let text = markdown
    .replace(/\u{E200}cite(?:\u{E202}[^\u{E201}]+)+\u{E201}/gu, "")
    .replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/gm, ` ${codeBlockOmitted} `)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*(\d+)\.\s+/gm, "$1、")
    .replace(/^[\s]*([-*_]\s?){3,}\s*$/gm, "\n")
    .replace(/<[^>]+>/g, "");
  const emphasis = /(\*\*|__|\*|_)(.*?)\1/g;
  while (/(\*\*|__|\*|_)(.*?)\1/.test(text)) text = text.replace(emphasis, "$2");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Preserve every character, including whitespace, while preferring sentence boundaries. */
export function splitSpeechText(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    const limit = result.length === 0 ? 160 : 400;
    let end = Math.min(offset + limit, chars.length);
    if (end < chars.length) {
      for (let index = end - 1; index >= offset; index--) {
        const char = chars[index];
        if (char !== undefined && /[。！？.!?\n]/u.test(char)) {
          end = index + 1;
          break;
        }
      }
    }
    result.push(chars.slice(offset, end).join(""));
    offset = end;
  }
  return result;
}
