import os from "node:os";
import path from "node:path";

export interface ApprovalActionTarget {
  path: string;
  operation: "read" | "write" | "delete" | "move" | "rollback";
}

export interface ApprovalActionTargets {
  targets: ApprovalActionTarget[];
  complete: boolean;
  limitations: string[];
  /** Syntactic effect candidate for model review, never an automatic allow rule. */
  shell?: {
    commands: string[];
    pipeline: boolean;
    effect: "read_only_candidate" | "mutation_or_unknown";
  };
}

/** Evidence extraction only. Never executes shell text or claims to parse arbitrary scripts. */
export function extractApprovalActionTargets(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
}): ApprovalActionTargets {
  const result: ApprovalActionTargets = { targets: [], complete: true, limitations: [] };
  const add = (value: string, operation: ApprovalActionTarget["operation"]) => {
    if (!value.trim()) {
      result.complete = false;
      result.limitations.push("empty_path");
      return;
    }
    if (result.targets.length >= 16 || value.length > 2_000 || value.includes("\0")) {
      result.complete = false;
      result.limitations.push("target_budget_exceeded");
      return;
    }
    const expanded = expandLiteralPath(value);
    if (!expanded) {
      result.complete = false;
      result.limitations.push("dynamic_path");
      return;
    }
    result.targets.push({ path: path.resolve(input.cwd, expanded), operation });
  };
  const filePath = ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
    .map((key) => input.toolInput[key])
    .find((value) => typeof value === "string");
  if (input.toolName !== "Bash" && input.toolName !== "FileChange" && typeof filePath === "string") {
    add(
      filePath,
      /read|grep|glob|ls/i.test(input.toolName)
        ? "read"
        : /delete|remove/i.test(input.toolName)
          ? "delete"
          : "write",
    );
    return result;
  }
  if (input.toolName === "FileChange") {
    const changes = input.toolInput.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!change || typeof change !== "object" || typeof change.path !== "string") {
          result.complete = false;
          continue;
        }
        const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
        add(change.path, kind === "delete" ? "delete" : "write");
      }
    } else {
      result.complete = false;
      result.limitations.push("file_change_details_missing");
    }
    return result;
  }
  if (input.toolName !== "Bash") return result;
  const command = ["command", "bash_command", "full_command"]
    .map((key) => input.toolInput[key])
    .find((value) => typeof value === "string");
  if (typeof command !== "string") {
    result.complete = false;
    result.limitations.push("command_missing");
    return result;
  }
  const commands = literalShellWords(command);
  if (!commands) {
    result.complete = false;
    result.limitations.push("shell_not_statically_resolved");
    return result;
  }
  result.shell = {
    commands: [],
    pipeline: commands.some((stage) => stage.piped),
    effect: "read_only_candidate",
  };
  const unknownEffects = () => {
    if (result.shell) result.shell.effect = "mutation_or_unknown";
  };
  let cwd = input.cwd;
  const addInCwd = (value: string, operation: ApprovalActionTarget["operation"]) => {
    const expanded = expandLiteralPath(value);
    if (expanded) add(path.resolve(cwd, expanded), operation);
    else add(value, operation);
  };
  for (const stage of commands) {
    const words = [...stage.words];
    if (words[0] === "command") words.shift();
    const program = path.basename(words.shift() ?? "");
    result.shell.commands.push(program);
    if (program === "cd") {
      const target = words.length === 1 ? expandLiteralPath(words[0] ?? "") : undefined;
      if (!target) {
        result.complete = false;
        unknownEffects();
        result.limitations.push("cwd_not_statically_resolved");
        break;
      }
      cwd = path.resolve(cwd, target);
      continue;
    }
    let redirects = words.findIndex((word) => word === ">" || word === ">>");
    while (redirects >= 0) {
      const destination = words[redirects + 1];
      if (destination) {
        addInCwd(destination, "write");
        // Discarding stdout/stderr is not a persistent data-file mutation.
        if (destination !== "/dev/null") unknownEffects();
      } else {
        result.complete = false;
        unknownEffects();
      }
      words.splice(redirects, 2);
      redirects = words.findIndex((word) => word === ">" || word === ">>");
    }
    if (program === "git") {
      unknownEffects();
      const shellCwd = cwd;
      if (words[0] === "-C" && words[1]) {
        const target = expandLiteralPath(words[1]);
        if (!target) {
          result.complete = false;
          continue;
        }
        cwd = path.resolve(cwd, target);
        words.splice(0, 2);
      }
      const verb = words.shift();
      if (!["rm", "restore", "clean", "reset"].includes(verb ?? "")) {
        if (verb?.startsWith("-")) {
          result.complete = false;
          result.limitations.push("git_options_not_statically_resolved");
        }
        cwd = shellCwd;
        continue;
      }
      const separator = words.indexOf("--");
      const paths =
        separator >= 0
          ? words.slice(separator + 1)
          : verb === "rm"
            ? words.filter((word) => !word.startsWith("-"))
            : [];
      if (!paths.length) {
        result.complete = false;
        result.limitations.push("git_scope_not_finite");
      }
      for (const target of paths) addInCwd(target, verb === "rm" || verb === "clean" ? "delete" : "rollback");
      cwd = shellCwd;
      continue;
    }
    if (program === "find" && isReadOnlyFind(words)) continue;
    if (words.some((word) => word.includes("$"))) unknownEffects();
    if (program === "rg" && words.some((word) => /^--(?:pre|hostname-bin)(?:=|$)/.test(word))) {
      result.complete = false;
      unknownEffects();
      result.limitations.push("search_can_execute_external_program");
      continue;
    }
    if (!["rm", "rmdir", "mkdir", "touch", "cp", "mv"].includes(program)) {
      if (
        !["ls", "pwd", "cat", "head", "tail", "rg", "grep", "echo", "printf", "true", "test"].includes(
          program,
        )
      ) {
        result.complete = false;
        unknownEffects();
        result.limitations.push("script_or_indirect_effects_require_semantic_review");
      }
      continue;
    }
    unknownEffects();
    if (["cp", "mv"].includes(program) && words.some((word) => /^(-t|--target-directory)/.test(word))) {
      result.complete = false;
      result.limitations.push("copy_move_options_not_statically_resolved");
      continue;
    }
    let afterSeparator = false;
    const args = words.filter((word) => {
      if (word === "--") {
        afterSeparator = true;
        return false;
      }
      return afterSeparator || !word.startsWith("-");
    });
    for (const [index, target] of args.entries()) {
      addInCwd(
        target,
        program === "rm" || program === "rmdir"
          ? "delete"
          : program === "mv" && index < args.length - 1
            ? "move"
            : program === "cp" && index < args.length - 1
              ? "read"
              : "write",
      );
    }
  }
  result.limitations = [...new Set(result.limitations)];
  return result;
}

/** Only literal roots and known non-writing predicates/actions; unknown options stay unknown. */
function isReadOnlyFind(words: readonly string[]): boolean {
  const values = new Set([
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-wholename",
    "-iwholename",
    "-type",
    "-maxdepth",
    "-mindepth",
    "-mtime",
    "-mmin",
    "-size",
    "-user",
    "-uid",
    "-group",
    "-gid",
  ]);
  const predicates = new Set([
    "-print",
    "-print0",
    "-prune",
    "-quit",
    "-o",
    "-or",
    "-a",
    "-and",
    "-not",
    "!",
    "-true",
    "-false",
    "-xdev",
    "-mount",
    "-depth",
    "-follow",
    "-H",
    "-L",
    "-P",
    "(",
    ")",
  ]);
  let expression = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    // The lexer retains an fd number before output redirection as a word.
    if (word === "2" && index === words.length - 1) continue;
    if (values.has(word)) {
      if (!words[++index]) return false;
      expression = true;
    } else if (predicates.has(word)) {
      expression = true;
    } else if (expression || word.startsWith("-") || !expandLiteralPath(word)) {
      return false;
    }
  }
  return true;
}

function expandLiteralPath(value: string): string | undefined {
  let expanded = value;
  for (const [name, replacement] of [
    ["HOME", os.homedir()],
    ["TMPDIR", os.tmpdir()],
  ] as const) {
    expanded = expanded
      .replace(new RegExp(`^\\$${name}(?=/|$)`), replacement)
      .replace(new RegExp(`^\\$\\{${name}\\}(?=/|$)`), replacement);
  }
  if (expanded === "~" || expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(1));
  return /[$`*?[\]{}]/.test(expanded) ? undefined : expanded;
}

/** Deliberately bounded subset: quoted words, simple chains/pipelines, and output redirections. */
function literalShellWords(command: string): Array<{ words: string[]; piped: boolean }> | undefined {
  if (
    command.length > 8_000 ||
    /[`\r\0]/.test(command) ||
    command.includes("<<") ||
    command.includes("$(") ||
    command.includes("||") ||
    (/(?:^|&&|;)\s*cd\b/.test(command) && /[;\n]/.test(command))
  )
    return undefined;
  const commands: Array<{ words: string[]; piped: boolean }> = [];
  let words: string[] = [],
    word = "",
    quote = "",
    started = false,
    piped = false;
  const flush = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (char === "\\" && quote !== "'") {
      if (index + 1 >= command.length) return undefined;
      if (command[index + 1] === "$" || command[index + 1] === "\n") return undefined;
      if (quote === '"' && !['"', "\\", "`"].includes(command.charAt(index + 1))) return undefined;
      word += command[++index];
      started = true;
      continue;
    }
    if (quote) {
      if (quote === "'" && char === "$") return undefined;
      if (char === quote) quote = "";
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "#" || char === "<" || char === "(" || char === ")") return undefined;
    if (char === "&" || char === "|") {
      const pipeline = char === "|" && command[index + 1] !== "|";
      if (!pipeline && command[index + 1] !== char) return undefined;
      if (!pipeline) index += 1;
      flush();
      if (!words.length) return undefined;
      commands.push({ words, piped: piped || pipeline });
      words = [];
      piped = pipeline;
      continue;
    }
    if (char === ";" || char === "\n") {
      flush();
      commands.push({ words, piped });
      words = [];
      piped = false;
      continue;
    }
    if (char === ">") {
      flush();
      if (command[index + 1] === ">") {
        index += 1;
        words.push(">>");
      } else words.push(">");
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return undefined;
  flush();
  if (!words.length && piped) return undefined;
  commands.push({ words, piped });
  // cd in a pipeline runs in a subshell; it cannot establish the following stage's cwd.
  if (
    commands.some(
      (stage) =>
        stage.piped &&
        path.basename(stage.words[0] === "command" ? (stage.words[1] ?? "") : (stage.words[0] ?? "")) ===
          "cd",
    )
  )
    return undefined;
  return commands.filter((entry) => entry.words.length > 0);
}
