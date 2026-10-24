import type { PackageManagerKind } from "./ipc";

/**
 * Build the package-manager argv for a script run.
 *
 * `args` are trailing arguments appended after `<pm> run <script>`.
 * Leading commands (nvm switch, env exports) are NOT part of argv — see
 * `joinPrefixedCommand` / main `buildPrefixedShellLine`.
 */
export function buildRunCommand(packageManager: PackageManagerKind, script: string, args?: string): string[] {
  const trimmedArgs = args?.trim();
  const tokens = trimmedArgs ? splitShellArgs(trimmedArgs) : [];
  switch (packageManager) {
    case "bun":
      return tokens.length > 0 ? ["bun", "run", script, ...tokens] : ["bun", "run", script];
    case "pnpm":
      return tokens.length > 0
        ? tokens[0] === "--"
          ? ["pnpm", "run", script, ...tokens]
          : ["pnpm", "run", script, "--", ...tokens]
        : ["pnpm", "run", script];
    case "yarn":
      return tokens.length > 0
        ? tokens[0] === "--"
          ? ["yarn", "run", script, ...tokens]
          : ["yarn", "run", script, "--", ...tokens]
        : ["yarn", "run", script];
    default:
      return tokens.length > 0
        ? tokens[0] === "--"
          ? ["npm", "run", script, ...tokens]
          : ["npm", "run", script, "--", ...tokens]
        : ["npm", "run", script];
  }
}

/** Join a leading shell command and the package-manager argv for display / clipboard. */
export function joinPrefixedCommand(prefix: string | undefined, command: readonly string[]): string {
  const normalizedPrefix = normalizeCommandPrefix(prefix);
  const body = command.map(quoteCommandArg).join(" ");
  return normalizedPrefix ? `${normalizedPrefix} && ${body}` : body;
}

/**
 * Leading command as authored by the user (shell fragment, not escaped).
 * A trailing connector (`nvm use 20 &&`) is dropped — we always insert `&&`.
 */
export function normalizeCommandPrefix(prefix: string | undefined): string {
  return (prefix ?? "")
    .trim()
    .replace(/(?:&&|\|\||[;&])\s*$/, "")
    .trim();
}

export function formatRunCommand(
  packageManager: PackageManagerKind,
  script: string,
  args?: string,
  prefix?: string,
): string {
  const base = joinPrefixedCommand(prefix, buildRunCommand(packageManager, script));
  const trailingArgs = args?.trim();
  if (!trailingArgs) return base;
  const separator = packageManager !== "bun" && !/^--(?:\s|$)/.test(trailingArgs) ? " --" : "";
  // Keep the authored shell syntax for preview/copy, including incomplete edits.
  return `${base}${separator} ${trailingArgs}`;
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** Parse quoting/escaping only; argument input does not expand shell expressions. */
function splitShellArgs(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next === undefined) throw new Error("Trailing escape in script arguments.");
      if (!quote || /[\\"$`\n]/.test(next)) {
        if (next !== "\n") {
          token += next;
          started = true;
        }
        index += 1;
        continue;
      }
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in script arguments.");
  if (started) tokens.push(token);
  return tokens;
}
