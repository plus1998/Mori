export function resolveDiffLanguage(path: string): string | undefined {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return "shell";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) : undefined;
  const languageByExtension: Readonly<Record<string, string>> = {
    cjs: "javascript",
    css: "css",
    go: "go",
    htm: "html",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mdx: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    yaml: "yaml",
    yml: "yaml",
    zsh: "shell",
  };
  return extension ? languageByExtension[extension] : undefined;
}
