import { dirname, isAbsolute, resolve } from "node:path";

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

import { isInside, realTarget } from "./paths";

/**
 * The background agent's PreToolUse policy: which tool calls may go ahead.
 *
 * It is one of three layers, and the only one that sees intent:
 *   1. this hook — denies publishing, pushing, gh, network tools, installs,
 *      Claude Code settings, and any Write/Edit outside the job's `work/`;
 *      reads (Read/Glob/Grep) stay inside `work/` and the skill;
 *   2. Claude Code's Bash sandbox (agent.ts) — every Bash command runs with
 *      writes confined to `work/` (and the sandbox's own temp dir), no network
 *      at all, secrets unreadable, and no way to run unsandboxed;
 *   3. the browser checks' own seatbelt profile (browser-tool.ts).
 * For Bash the hook's path checks are a best-effort reading of the command
 * line (it cannot see inside `node -e "…"`); the sandbox is the boundary there.
 */

export const BROWSER_TOOL_ID = "mcp__studio__browser_check";
export const SKILL_NAMES = ["studio:anatomy", "anatomy"];

export type GuardContext = {
  /** the job's `work/` folder, a real path: the only place writes may land */
  work: string;
  /** real paths a file tool may read: `work/` and the skill */
  readRoots: string[];
  /** further paths a Bash command may name, matched as written: system binaries, node, /dev */
  execRoots: string[];
};

export type Verdict = { ok: true } | { ok: false; reason: string };

const ALLOW: Verdict = { ok: true };
const deny = (reason: string): Verdict => ({ ok: false, reason });

/** commands the agent never runs, by name */
const DENIED_COMMANDS: Record<string, string> = {
  gh: "GitHub access is off in this studio",
  curl: "there is no network here",
  wget: "there is no network here",
  ssh: "there is no network here",
  scp: "there is no network here",
  sftp: "there is no network here",
  rsync: "there is no network here",
  ftp: "there is no network here",
  telnet: "there is no network here",
  nc: "there is no network here",
  ncat: "there is no network here",
  netcat: "there is no network here",
  socat: "there is no network here",
  npm: "nothing needs installing: the skill has no dependencies",
  npx: "nothing needs installing: the skill has no dependencies",
  pnpm: "nothing needs installing: the skill has no dependencies",
  yarn: "nothing needs installing: the skill has no dependencies",
  bun: "nothing needs installing: the skill has no dependencies",
  bunx: "nothing needs installing: the skill has no dependencies",
  pip: "nothing needs installing: the skill has no dependencies",
  pip3: "nothing needs installing: the skill has no dependencies",
  brew: "nothing needs installing: the skill has no dependencies",
  open: "there is no screen to open things on; read the PNGs instead",
  osascript: "not available in this studio",
  security: "not available in this studio",
  launchctl: "not available in this studio",
  crontab: "not available in this studio",
  docker: "not available in this studio",
  sudo: "not available in this studio",
  su: "not available in this studio",
  kill: "not available in this studio",
  pkill: "not available in this studio",
  killall: "not available in this studio",
  ln: "links are off: they can point out of the job folder",
  claude: "not available in this studio",
};

/** git subcommands that reach a remote or change identity */
const GIT_REMOTE = /\bgit\b[^;&|\n]*\b(push|pull|fetch|clone|remote|submodule|ls-remote|send-email|request-pull|credential|config)\b/;
/** the skill's scripts that start Chrome, which cannot start in the Bash sandbox */
const CHROME_SCRIPT = /\bnode\b[^;&|\n]*\b(capture|drive|lines|turn-check|print|print-sheet)\.mjs\b/;
const BROWSER_HINT =
  "Chrome can't start inside the Bash sandbox: run capture.mjs, drive.mjs and lines.mjs through the browser_check tool instead (same arguments)";

/** commands that take every operand as a path they write */
const WRITES_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "truncate", "unlink", "shred", "tee"]);
/** commands whose last operand is where they write */
const WRITES_LAST = new Set(["cp", "mv", "install"]);
/** commands whose first operand is a mode or owner, the rest paths they write */
const WRITES_AFTER_FIRST = new Set(["chmod", "chown", "chgrp"]);
/** wrappers that run the command after them */
const WRAPPERS = new Set(["env", "nohup", "time", "command", "exec", "nice", "xargs", "builtin"]);
/** shells that run a command passed as a string with -c */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** options whose value is a file some tool writes */
const OUT_FLAGS = new Set(["--out", "-o", "--output", "--out-dir", "--outdir"]);

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

/** `.claude` anywhere in a path: Claude Code's own settings and state */
const touchesClaudeDir = (path: string) => /(^|[\\/])\.claude([\\/]|$)/.test(path);

function insideAny(path: string, roots: string[]) {
  return roots.some((root) => isInside(path, root));
}

function checkWritePath(path: string, base: string, ctx: GuardContext): Verdict {
  if (touchesClaudeDir(path)) return deny("Claude Code's .claude folders are off limits");
  if (/[`$]/.test(path) && !/^"?\$\{?TMPDIR\}?"?\//.test(path))
    return deny(`write to a literal path inside the job folder, not ${path}`);
  if (SAFE_DEVICES.has(path)) return ALLOW;
  if (/^\$\{?TMPDIR\}?\//.test(path.replace(/^"/, ""))) return ALLOW;
  // a glob writes wherever its fixed prefix is
  const fixed = path.replace(/[*?[{].*$/, "") || ".";
  const real = realTarget(fixed, base);
  return isInside(real, ctx.work)
    ? ALLOW
    : deny(`only the job folder (${ctx.work}) is writable; ${path} is outside it`);
}

/**
 * A read stays inside `roots` by its real path, so a link in the job folder
 * cannot reach out of it. `lexical` roots (system binary folders, whose
 * entries are often links into a package manager's store) match as written.
 */
function checkReadPath(path: string, base: string, roots: string[], lexical: string[] = []): Verdict {
  if (touchesClaudeDir(path)) return deny("Claude Code's .claude folders are off limits");
  const fixed = path.replace(/[*?[{].*$/, "") || ".";
  if (insideAny(realTarget(fixed, base), roots)) return ALLOW;
  if (lexical.length && insideAny(resolve(base, fixed), lexical)) return ALLOW;
  return deny(`${path} is outside the job folder and the skill`);
}

/** --- the Bash command line, read the way a careful reviewer would ------- */

type Word = { text: string; quoted: boolean };

/**
 * Split a command line into simple commands (at ; && || | & newlines and
 * subshell/substitution brackets) and each into words, honouring quotes. Not a
 * shell — enough to find command names, redirections and operands.
 */
export function splitCommands(command: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let word = "";
  let quoted = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push({ text: word, quoted });
    word = "";
    quoted = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      quoted = true;
      inWord = true;
      i = end;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      // keep redirections like 2>&1 and &> together with their word
      if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        word += c;
        inWord = true;
        continue;
      }
      endCommand();
    } else if (c === "$" && command[i + 1] === "(") {
      endCommand();
      i++;
    } else if (c === ">" || c === "<") {
      // a redirection operator is its own word, unless it follows a digit/& (2>, &>)
      const prefix = /^[0-9&]$/.test(word) ? word : "";
      if (!prefix) endWord();
      let op = prefix + c;
      while (command[i + 1] === ">" || command[i + 1] === "&" || command[i + 1] === "|") op += command[++i];
      words.push({ text: op, quoted: false });
      word = "";
      quoted = false;
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const isRedirect = (text: string) => /^[0-9&]?>{1,2}[&|]?$|^<$/.test(text);
/**
 * A word that names a file: absolute, home-relative, dot-relative, or a plain
 * relative path like `shots/desk.png`. A snippet of code (`require('../x')`
 * inside `node -e`) is not one; the sandbox covers what that does.
 */
const looksLikePath = (text: string) =>
  text.startsWith("/") ||
  text.startsWith("~") ||
  text === ".." ||
  /^\.{1,2}\//.test(text) ||
  /^[\w.@+-]+(?:\/[\w.@+-]*)+$/.test(text);

/** the commands inside $(…) and `…`, which a quoted word would otherwise hide */
function substitutions(command: string): string[] {
  const inner: string[] = [];
  for (const match of command.matchAll(/\$\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g)) inner.push(match[1] ?? match[2] ?? "");
  return inner.filter((text) => text.trim());
}

function checkBash(command: string, ctx: GuardContext, cwd: string, depth = 0): Verdict {
  if (depth < 4) {
    for (const inner of substitutions(command)) {
      const verdict = checkBash(inner, ctx, cwd, depth + 1);
      if (!verdict.ok) return verdict;
    }
  }
  if (/publish/i.test(command)) return deny("publishing is off in this studio: figures stay on this machine");
  if (GIT_REMOTE.test(command)) return deny("git remotes are off in this studio: nothing is pushed or fetched");
  if (CHROME_SCRIPT.test(command)) return deny(BROWSER_HINT);
  if (touchesClaudeDir(command) || /(^|[\s'"=])\.claude\b/.test(command))
    return deny("Claude Code's .claude folders are off limits");

  let base = cwd;
  for (const words of splitCommands(command)) {
    // the command name, past VAR=value assignments and wrappers like env/xargs
    let index = 0;
    while (index < words.length) {
      const text = words[index].text;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) index++;
      else if (WRAPPERS.has(text)) {
        index++;
        while (index < words.length && words[index].text.startsWith("-")) index++;
      } else break;
    }
    const name = words[index]?.text.split("/").pop() ?? "";
    if (name in DENIED_COMMANDS) return deny(`${name}: ${DENIED_COMMANDS[name]}`);
    // a shell given its command as a string (sh -c "…", eval "…"): read that too
    const script =
      name === "eval"
        ? words.slice(index + 1).map((w) => w.text).join(" ")
        : SHELLS.has(name)
          ? words[words.findIndex((w, i) => i > index && /^-\w*c\w*$/.test(w.text)) + 1]?.text
          : undefined;
    if (script && depth < 4) {
      const verdict = checkBash(script, ctx, base, depth + 1);
      if (!verdict.ok) return verdict;
    }
    if (name === "git" && words.slice(index + 1).some((w) => GIT_REMOTE.test(`git ${w.text}`)))
      return deny("git remotes are off in this studio: nothing is pushed or fetched");

    const args = words.slice(index + 1);
    const operands: string[] = [];
    const writes: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const text = args[i].text;
      if (isRedirect(text)) {
        const target = args[i + 1]?.text;
        if (target && !target.startsWith("&") && text !== "<") writes.push(target);
        if (target && text === "<") operands.push(target);
        i++;
        continue;
      }
      const attached = /^([0-9&]?>{1,2})(.+)$/.exec(text);
      if (attached && !attached[2].startsWith("&")) {
        writes.push(attached[2]);
        continue;
      }
      if (OUT_FLAGS.has(text) && args[i + 1]) {
        writes.push(args[++i].text);
        continue;
      }
      const flagValue = /^(--out|--output|--out-dir|--outdir)=(.+)$/.exec(text);
      if (flagValue) {
        writes.push(flagValue[2]);
        continue;
      }
      if (name === "dd" && text.startsWith("of=")) {
        writes.push(text.slice(3));
        continue;
      }
      if (!text.startsWith("-")) operands.push(text);
    }

    if (WRITES_ALL.has(name)) writes.push(...operands);
    else if (WRITES_LAST.has(name) && operands.length) writes.push(operands[operands.length - 1]);
    else if (WRITES_AFTER_FIRST.has(name)) writes.push(...operands.slice(1));
    else if (name === "sed" && args.some((w) => /^-i/.test(w.text) || w.text === "--in-place"))
      writes.push(...operands.slice(1));

    for (const target of writes) {
      const verdict = checkWritePath(target, base, ctx);
      if (!verdict.ok) return verdict;
    }
    // every path-looking word must stay inside the studio's readable places
    for (const word of [words[index], ...args]) {
      if (!word) continue;
      const text = word.text.replace(/^(?:--?[\w-]+|[A-Za-z_][A-Za-z0-9_]*)=/, "");
      if (!looksLikePath(text) || SAFE_DEVICES.has(text) || /[`$]/.test(text)) continue;
      const verdict = checkReadPath(text, base, ctx.readRoots, ctx.execRoots);
      if (!verdict.ok) return verdict;
    }

    if (name === "cd") {
      const target = operands[0];
      if (!target || target === "~" || target === "-" || /[`$]/.test(target))
        return deny("stay inside the job folder or the skill: cd there by a literal path");
      // into the job folder, or into the (read-only) skill to look around:
      // a write from there still has to land in the job folder
      const next = realTarget(target, base);
      if (!insideAny(next, ctx.readRoots)) return deny(`stay inside the job folder or the skill: ${target} is outside them`);
      base = next;
    }
  }
  return ALLOW;
}

/** --- the decision ----------------------------------------------------- */

/**
 * `cwd` is where the session's shell is (the hook input says); it only counts
 * while it is inside `work/`, which is where every relative path resolves.
 */
export function checkToolUse(tool: string, input: unknown, ctx: GuardContext, cwd?: string): Verdict {
  const base = cwd && isInside(realTarget(cwd, ctx.work), ctx.work) ? realTarget(cwd, ctx.work) : ctx.work;
  switch (tool) {
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = asString(field(input, "file_path")) ?? asString(field(input, "notebook_path"));
      if (!path) return deny("a file path is required");
      return checkWritePath(path, base, ctx);
    }
    case "Read": {
      const path = asString(field(input, "file_path"));
      if (!path) return deny("a file path is required");
      return checkReadPath(path, base, ctx.readRoots);
    }
    case "Glob":
    case "Grep": {
      const path = asString(field(input, "path"));
      if (path) {
        const verdict = checkReadPath(path, base, ctx.readRoots);
        if (!verdict.ok) return verdict;
      }
      const root = path ? realTarget(path, base) : base;
      for (const key of ["pattern", "glob"]) {
        const pattern = asString(field(input, key));
        if (!pattern) continue;
        if (tool === "Grep" && key === "pattern") continue; // a regex, not a path
        if (isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..")) {
          const verdict = checkReadPath(pattern, root, ctx.readRoots);
          if (!verdict.ok) return verdict;
        }
      }
      return ALLOW;
    }
    case "Bash": {
      const command = asString(field(input, "command"));
      if (!command) return deny("an empty command");
      if (field(input, "dangerouslyDisableSandbox") === true)
        return deny("every command runs in the sandbox here");
      return checkBash(command, ctx, base);
    }
    case "Skill": {
      const name = asString(field(input, "skill")) ?? asString(field(input, "name")) ?? "";
      return SKILL_NAMES.includes(name.replace(/^\//, ""))
        ? ALLOW
        : deny("only the anatomy skill is available in this studio");
    }
    case BROWSER_TOOL_ID:
      return ALLOW; // it checks its own arguments, and runs under its own seatbelt profile
    default:
      return deny(`${tool} is not available in this studio`);
  }
}

/** the SDK hook around `checkToolUse`; `onDeny` hears about every refusal */
export function createGuardHooks(
  ctx: GuardContext,
  onDeny: (tool: string, reason: string) => void = () => {},
): HookCallbackMatcher[] {
  return [
    {
      // a hook that throws must not wave the call through
      onFailure: "block",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const verdict = checkToolUse(input.tool_name, input.tool_input, ctx, input.cwd);
          if (verdict.ok) return {};
          onDeny(input.tool_name, verdict.reason);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: verdict.reason,
            },
          };
        },
      ],
    },
  ];
}

/** the guard's view of a job: writes in `work/`, reads in `work/` and the skill */
export function guardContext(work: string, skill: string, nodeBinary = process.execPath): GuardContext {
  const nodeDir = dirname(nodeBinary);
  return {
    work,
    readRoots: [work, skill],
    execRoots: [
      "/dev",
      "/bin",
      "/usr/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      nodeDir,
      // the Bash sandbox's own TMPDIR
      `/private/tmp/claude-${typeof process.getuid === "function" ? process.getuid() : 0}`,
    ],
  };
}
