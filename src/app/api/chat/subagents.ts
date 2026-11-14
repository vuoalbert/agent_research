import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { shapeAt, type Subagent } from "@/lib/subagents";

import {
  EXTRACT_TOOL_ID,
  TAVILY_SERVER,
  TAVILY_TOOL_ID,
  createTavilyServer,
  type PageSeen,
  type ToolActivity,
} from "./tavily";
import { VAULT_READ_TOOL, VAULT_SEARCH_TOOL, createVaultTools, type VaultActivity } from "./vault-tools";

/**
 * `deploy_subagents` — the chat Claude splits a research question into a few
 * angles and hands each to its own Opus subagent, all at once.
 *
 * Each subagent is a nested `query()` (at most 4 at a time) with a scoped
 * `research` server of its own: web search and page reads, and the vault
 * read-only. No cross_reference, no visualize, no vault_write, and no
 * deploy_subagents, so a subagent cannot spawn more. It researches its angle
 * and ends with a compact result (headline, ≤5 bullets, claims with source
 * URLs, disagreements); the tool hands every result back to the chat Claude,
 * which compares them.
 *
 * What the reader sees:
 *   - one `tool` row, `{ id, name: "Subagents", action: "subagents", query,
 *     status, subagents }`, re-sent (same id, `running`) each time a subagent
 *     moves on — its `line` is its latest search or read, then its one-line
 *     result — and `done` once all have finished;
 *   - every search, read and vault call a subagent makes, as the usual `tool`
 *     rows, tagged with `parentId` (the group) and `agentId` (the subagent).
 *     Their pages go through the same `onPages` as the chat's own, so the
 *     cross-reference log and the vault recorder count them.
 */

export const SUBAGENTS_TOOL = "deploy_subagents";
/** the name Claude Code knows the tool by, for `allowedTools` */
export const SUBAGENTS_TOOL_ID = `mcp__${TAVILY_SERVER}__${SUBAGENTS_TOOL}`;
export const SUBAGENT_MODEL = "claude-opus-5-5";
export const SUBAGENT_EFFORT = "medium" as const;
export const MIN_SUBAGENTS = 2;
export const MAX_SUBAGENTS = 5;
/** subagents running at once; a fifth waits for a slot */
export const SUBAGENT_CONCURRENCY = 4;
export const SUBAGENT_MAX_TURNS = 8;
export const SUBAGENT_TIMEOUT_MS = 3 * 60_000;
/** the tools a subagent may call — and nothing else */
export const SUBAGENT_TOOL_IDS = [
  TAVILY_TOOL_ID,
  EXTRACT_TOOL_ID,
  `mcp__${TAVILY_SERVER}__${VAULT_SEARCH_TOOL}`,
  `mcp__${TAVILY_SERVER}__${VAULT_READ_TOOL}`,
];
const LINE_CHARS = 140;

export const SUBAGENT_PROMPT = [
  "You are a research subagent for Agent Research. A lead researcher split a question into angles and gave you ONE. Research only your angle; the others are covered.",
  "Tools: tavily_search (web search), tavily_extract (read 1-5 pages in full), vault_search and vault_read (notes from earlier research, read-only).",
  "Work quickly: 1-3 focused searches, then read the 2-3 most relevant pages, preferably primary or official sources, with tavily_extract. Don't repeat a search.",
  "Report only what the pages you saw say, each fact with its source URL. Note where sources disagree (different numbers, dates or claims for the same thing).",
  "End with exactly this and nothing before it:",
  "Headline: <one sentence, at most 120 characters: the key finding, with its main number or date>",
  "Summary:",
  "- <at most 5 bullets>",
  "Key claims:",
  "- <claim with its numbers and dates> — <source URL>",
  "Disagreements:",
  "- <source A says X, source B says Y> (or: - none found)",
].join("\n");

export type SubagentTask = { title: string; task: string };

export type SubagentsActivity =
  | {
      id: string;
      name: "Subagents";
      action: "subagents";
      query: string;
      status: "running" | "done";
      subagents: Subagent[];
    }
  /** a subagent's own search, read or vault call, tagged with its group and subagent */
  | ((ToolActivity | VaultActivity) & { parentId: string; agentId: string });

export type SubagentResult = { title: string; status: "done" | "error"; text: string };

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const flat = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string, max = LINE_CHARS) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** the tool's input, checked again in the handler: 2-5 subagents, each with a title and a task */
export function validateSubagents(value: unknown): { ok: true; subagents: SubagentTask[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "subagents must be a list of { title, task }." };
  if (value.length < MIN_SUBAGENTS || value.length > MAX_SUBAGENTS) {
    return { ok: false, message: `Deploy ${MIN_SUBAGENTS} to ${MAX_SUBAGENTS} subagents (got ${value.length}).` };
  }
  const subagents: SubagentTask[] = [];
  for (const entry of value) {
    const { title, task } = (entry ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || typeof task !== "string" || !task.trim()) {
      return { ok: false, message: "Each subagent needs a non-empty title and task." };
    }
    subagents.push({ title: clip(flat(title), 80), task: task.trim() });
  }
  return { ok: true, subagents };
}

/** the one line a finished subagent shows: its `Headline:`, else its first line of prose */
export function headlineOf(result: string): string {
  const headline = /^\s*\**headline\**:\**\s*(.+)$/im.exec(result)?.[1];
  const first =
    headline ??
    result
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find((line) => line && !/^(summary|key claims|disagreements):?$/i.test(line)) ??
    "";
  return clip(flat(first.replace(/\*\*/g, ""))) || "Finished";
}

/** what a subagent's search, read or vault call says it is doing */
function lineFor(activity: { name?: string; action?: string; op?: string; query?: string }): string {
  const q = clip(flat(activity.query ?? ""), 110);
  if (activity.action === "vault") return activity.op === "read" ? `Reading note ${q}` : `Checking the vault for ${q}`;
  if (activity.action === "read") return `Reading ${q}`;
  return `Searching “${q}”`;
}

/** run `fn` over `items`, at most `limit` at a time, results in input order */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** what goes back to the chat Claude: every subagent's result, to compare */
export function formatResults(results: readonly SubagentResult[]): string {
  const finished = results.filter((result) => result.status === "done").length;
  const parts = results.map(
    (result, i) =>
      `### Subagent ${i + 1}: ${result.title} (${result.status === "done" ? "finished" : "did not finish"})\n` +
      (result.text.trim() || "(no result)"),
  );
  return [
    `Subagent findings (${finished} of ${results.length} finished). Compare them: where they agree, where they ` +
      "disagree (which source says what), and what is still missing. Their sources are already in cross_reference.",
    ...parts,
  ].join("\n\n");
}

const blockText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n")
    : "";

export function createSubagentsTool({
  onActivity,
  onPages,
  signal,
  question,
  timeoutMs = SUBAGENT_TIMEOUT_MS,
  concurrency = SUBAGENT_CONCURRENCY,
  vaultDir,
}: {
  onActivity: (activity: SubagentsActivity) => void;
  /** every page a subagent's search or read returned, like the chat's own */
  onPages?: (pages: PageSeen[]) => void;
  /** the request's: Stop ends every subagent */
  signal?: AbortSignal;
  /** the user's question, as context for each subagent */
  question?: string;
  timeoutMs?: number;
  concurrency?: number;
  vaultDir?: string;
}) {
  let deployed = false;

  return tool(
    SUBAGENTS_TOOL,
    `Deploy ${MIN_SUBAGENTS}-${MAX_SUBAGENTS} research subagents (Opus) in parallel, one per angle of the question. ` +
      "Each searches the web, reads the best pages and returns a headline, a short summary, key claims with source " +
      "URLs and the disagreements it found. Give each a short title (2-5 words) and a self-contained task. Once per turn.",
    {
      subagents: z
        .array(
          z.object({
            title: z.string().min(1).max(80).describe("A short name for the angle, 2-5 words"),
            task: z.string().min(1).max(2000).describe("What this subagent should find out, self-contained"),
          }),
        )
        .min(MIN_SUBAGENTS)
        .max(MAX_SUBAGENTS)
        .describe(`${MIN_SUBAGENTS} to ${MAX_SUBAGENTS} complementary angles`),
    },
    async (args) => {
      const checked = validateSubagents((args as { subagents?: unknown })?.subagents);
      if (!checked.ok) return text(checked.message, true);
      if (deployed) return text("Subagents were already deployed this turn: compare their findings instead.", true);
      deployed = true;

      const groupId = crypto.randomUUID();
      const rows: Subagent[] = checked.subagents.map((sub, index) => ({
        id: crypto.randomUUID(),
        title: sub.title,
        shape: shapeAt(index),
        status: "running",
        line: "Waiting to start",
      }));
      const groupQuery = rows.map((row) => row.title).join(" · ");
      const report = (status: "running" | "done") =>
        onActivity({
          id: groupId,
          name: "Subagents",
          action: "subagents",
          query: groupQuery,
          status,
          subagents: rows.map((row) => ({ ...row })),
        });
      report("running");

      const runOne = async (sub: SubagentTask, index: number): Promise<SubagentResult> => {
        const row = rows[index];
        const controller = new AbortController();
        let timedOut = false;
        const stop = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

        /** a subagent's call: forwarded tagged, and its start becomes the row's line */
        const forward = (activity: ToolActivity | VaultActivity) => {
          onActivity({ ...activity, parentId: groupId, agentId: row.id });
          if (activity.status === "running" && row.status === "running") {
            row.line = lineFor(activity);
            report("running");
          }
        };
        const server = createTavilyServer(forward, {
          onPages,
          tools: createVaultTools({ onActivity: forward, dir: vaultDir }).filter(
            (definition) => definition.name === VAULT_SEARCH_TOOL || definition.name === VAULT_READ_TOOL,
          ),
        });

        row.startedAt = Date.now();
        row.line = "Starting";
        report("running");
        const said: string[] = [];
        try {
          const run = query({
            prompt:
              (question ? `The lead researcher's question (context only): ${question}\n\n` : "") +
              `Your angle: ${sub.title}\n\nYour task: ${sub.task}`,
            options: {
              model: SUBAGENT_MODEL,
              effort: SUBAGENT_EFFORT,
              systemPrompt: SUBAGENT_PROMPT,
              // no built-ins, no repo settings, only the scoped server's tools
              tools: [],
              settingSources: [],
              mcpServers: { [TAVILY_SERVER]: server },
              allowedTools: SUBAGENT_TOOL_IDS,
              permissionMode: "dontAsk",
              maxTurns: SUBAGENT_MAX_TURNS,
              abortController: controller,
            },
          });
          let result: string | undefined;
          let stopped: string | undefined;
          for await (const message of run) {
            if (message.type === "assistant") {
              const words = blockText((message as { message?: { content?: unknown } }).message?.content);
              if (words.trim()) said.push(words);
            } else if (message.type === "result") {
              if (message.subtype === "success") result = message.result;
              else stopped = message.subtype;
            }
          }
          const out = (result?.trim() ? result : said.at(-1)) ?? "";
          if (!out.trim()) throw new Error(stopped ? `stopped: ${stopped}` : "returned no result");
          row.status = "done";
          row.line = headlineOf(out);
          return { title: sub.title, status: "done", text: out };
        } catch (error) {
          row.status = "error";
          row.line = timedOut
            ? `Timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`}`
            : signal?.aborted
              ? "Stopped"
              : clip(`Failed: ${error instanceof Error ? error.message : String(error)}`);
          console.warn(`[subagents] "${sub.title}": ${row.line}`);
          const partial = said.at(-1) ?? "";
          return { title: sub.title, status: "error", text: partial ? `${row.line}. Partial notes:\n${partial}` : row.line };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          row.finishedAt = Date.now();
          report("running");
        }
      };

      const results = await pool(checked.subagents, concurrency, runOne);
      report("done");
      const finished = results.filter((result) => result.status === "done").length;
      console.info(`[subagents] ${finished} of ${results.length} finished`);
      return text(formatResults(results), finished === 0);
    },
  );
}
