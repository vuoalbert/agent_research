import { relative } from "node:path";

import { BROWSER_TOOL_ID } from "./policy";

/**
 * Short progress lines from the background agent's SDK messages, the way a
 * terminal would show them: "Bash: node build.mjs --light", "Read: shots/desk.png",
 * "Browser: capture figure.html --out shots/desk.png", or the first words of
 * what it said. Paths are shown relative to the job folder (or as
 * `anatomy/…` inside the skill), so a line stays one line.
 */

type Block = { type: string; text?: string; name?: string; input?: unknown };
type MessageLike = { type: string; subtype?: unknown; message?: unknown; num_turns?: unknown };

const SNIPPET = 160;

const flat = (value: string) => value.replace(/\s+/g, " ").trim();
const cut = (value: string, max = SNIPPET) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function field(input: unknown, key: string): string | undefined {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

export function describeTool(
  name: string,
  input: unknown,
  places: { work: string; skill: string },
): string {
  const show = (path: string | undefined) => {
    if (!path) return "";
    if (path.startsWith(places.skill)) return `anatomy/${relative(places.skill, path)}`;
    if (path.startsWith(places.work)) return relative(places.work, path) || ".";
    return path;
  };
  const shorten = (value: string) => value.split(places.work).join(".").split(places.skill).join("anatomy");
  switch (name) {
    case "Bash":
      return `Bash: ${cut(flat(shorten((field(input, "command") ?? "").split("\n")[0])))}`;
    case "Read":
    case "Write":
    case "Edit":
      return `${name}: ${show(field(input, "file_path"))}`;
    case "Glob":
    case "Grep":
      return `${name}: ${cut(field(input, "pattern") ?? "")}`;
    case "Skill":
      return `Skill: ${field(input, "skill") ?? ""}`;
    case BROWSER_TOOL_ID: {
      const script = field(input, "script") ?? "";
      const args = typeof input === "object" && input !== null ? (input as { args?: unknown }).args : undefined;
      const list = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
      return `Browser: ${cut(flat(shorten(`${script} ${list.join(" ")}`)))}`;
    }
    default:
      return name;
  }
}

/** zero or more lines for one SDK message */
export function describeMessage(message: MessageLike, places: { work: string; skill: string }): string[] {
  if (message.type === "assistant") {
    const inner = message.message;
    const content = typeof inner === "object" && inner !== null ? (inner as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) return [];
    const lines: string[] = [];
    for (const block of content as Block[]) {
      if (block.type === "text" && block.text && flat(block.text)) lines.push(cut(flat(block.text)));
      else if (block.type === "tool_use" && block.name) lines.push(describeTool(block.name, block.input, places));
    }
    return lines;
  }
  if (message.type === "result") {
    const turns = typeof message.num_turns === "number" ? ` after ${message.num_turns} turns` : "";
    return [message.subtype === "success" ? `Agent finished${turns}` : `Agent stopped: ${String(message.subtype)}${turns}`];
  }
  return [];
}
