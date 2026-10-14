import { resolveDiffLanguage } from "./diff-language";

const SHIKI_ALIAS: Readonly<Record<string, string>> = {
  shell: "shellscript",
  bash: "shellscript",
  sh: "shellscript",
  zsh: "shellscript",
  ts: "typescript",
  js: "javascript",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  htm: "html",
  cjs: "javascript",
  mjs: "javascript",
  rs: "rust",
  py: "python",
  rb: "ruby",
};

export function resolveShikiLanguage(path: string): string {
  const fromPath = resolveDiffLanguage(path);
  if (!fromPath) return "plaintext";
  return SHIKI_ALIAS[fromPath] ?? fromPath;
}
