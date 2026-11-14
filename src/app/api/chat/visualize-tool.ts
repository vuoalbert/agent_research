import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { getRunner, type StartInput, type StartResult } from "@/server/visualize/runner";

import { researchBrief } from "./visualize-brief";

/**
 * visualize — the chat Claude's way to commission a figure, and the rule that
 * every research turn ends with one.
 *
 * There is only ever one visualization (src/server/visualize/runner.ts). A
 * call queues nothing: it starts the figure at once, in the background, or —
 * when it is not `explicit` and the current one is still building — does
 * nothing at all. `explicit` (the user's own message asks for a figure)
 * replaces the current one, running or not. The agent behind it can take
 * 15–60 minutes; the Visualize tab shows its progress and then the figure.
 * The chat turn never waits, and stopping the chat does not stop the figure.
 *
 * One `createVisualizeTurn` per request:
 *   - `server`: the in-process MCP server with the tool, reporting to that
 *     request's stream — `running` with the job's id, then `done`; the tool
 *     row follows the job from there. A busy call reports a row that says
 *     "already building …". At most ONE call per turn does anything.
 *   - `observe(message)`: watches the turn's SDK messages for research tool
 *     calls (search, read, cross-reference), their results, and the answer.
 *   - `finish(question)`, after a turn that finished normally: if it did
 *     research and Claude did not call visualize, it starts the figure itself
 *     (not explicit, so a figure still building is left alone), with a brief
 *     of the turn's facts (visualize-brief.ts). So every research turn yields
 *     exactly one visualization attempt, whatever the model chose.
 *   - `tools`: more tools for the same server (the chat's line to the agent,
 *     visualize-message-tool.ts); `claim()` says the turn has its figure
 *     already — a message reached it — so `finish` starts none.
 */

export const VISUALIZE_SERVER = "visualize";
export const VISUALIZE_TOOL = "visualize";
/** the name Claude Code knows the tool by, for `allowedTools` */
export const VISUALIZE_TOOL_ID = `mcp__${VISUALIZE_SERVER}__${VISUALIZE_TOOL}`;

/** appended to the chat's system prompt */
export const VISUALIZE_PROMPT = [
  "Visualize (one figure at a time, built in the background in the Visualize tab, about 15-60 minutes):",
  "- While researching, collect material that visualizes well: concrete quantities with units and dates (time series, before/after), comparisons and rankings, the parts of a system and how they connect, cause→effect chains, and where sources disagree. Keep each claim crisp and attributable to specific sources. Don't make the answer longer for it.",
  "- After researching (tavily_search, tavily_extract or cross_reference), call visualize once, near the end, with explicit: false — a subject that turns the findings into a physical, mechanical figure the anatomy skill can draw (a gauge, counter, balance, machine or cutaway whose parts and readout encode the key numbers and claims), and a brief in this structure:",
  "  Key numbers: - value unit (date) — source host",
  "  Parts and relations: - entity/part → how it connects to or drives another",
  "  Conflicts: - source vs source on which claim",
  "  Object idea: one line",
  "  If a figure is still building, this call does nothing; that's expected.",
  "- Only when the user's message explicitly asks you to visualize, illustrate, diagram or draw something, call visualize with explicit: true; that replaces the current figure.",
  "- At most one visualize call per turn. Mention it in one sentence; don't describe the figure as if it were finished.",
].join("\n");

export type VisualizeActivity =
  | { id: string; name: "Visualize"; action: "visualize"; query: string; jobId?: string; status: "running" }
  | { id: string; status: "done" }
  | { id: string; status: "error"; message: string };

export type StartJob = (input: StartInput) => StartResult;

const defaultStart: StartJob = (input) => getRunner().startJob(input);

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

/** the question as a subject: one line, at most 200 characters, cut on a word */
export function subjectFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 199);
  const space = cut.lastIndexOf(" ");
  return `${(space > 120 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type Block = {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
};

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";

export function createVisualizeTurn({
  onActivity,
  researchTools,
  crossrefTool,
  start = defaultStart,
  tools = [],
}: {
  onActivity: (activity: VisualizeActivity) => void;
  /** the tool names (as Claude Code knows them) that count as research */
  researchTools: readonly string[];
  /** which of them is cross_reference, whose table feeds the brief's claims */
  crossrefTool?: string;
  start?: StartJob;
  // `any`: the SDK types its own tools list this way
  tools?: SdkMcpToolDefinition<any>[];
}) {
  let researched = false;
  let attempted = false;
  const answer: string[] = [];
  const pages: string[] = [];
  const crossrefs: string[] = [];
  /** tool_use id → tool name, to file each result under its tool */
  const calls = new Map<string, string>();

  /** start (or not) and report it as the turn's Visualize row */
  const begin = (input: StartInput) => {
    let result: StartResult;
    try {
      result = start(input);
    } catch (error) {
      const id = crypto.randomUUID();
      const message = `Couldn't start the visualization: ${error instanceof Error ? error.message : String(error)}`;
      onActivity({ id, name: "Visualize", action: "visualize", query: input.subject, status: "running" });
      onActivity({ id, status: "error", message });
      return { message, isError: true };
    }
    if (result.status === "busy") {
      // nothing started: a muted row that says what is still building
      const id = crypto.randomUUID();
      onActivity({ id, name: "Visualize", action: "visualize", query: `already building ${result.job.subject}`, status: "running" });
      onActivity({ id, status: "done" });
      return {
        message: `A visualization of ${result.job.subject} is still building, so this one was not started (only one at a time). Say the current one is still in progress.`,
        isError: false,
      };
    }
    const { job, replaced } = result;
    onActivity({ id: job.id, name: "Visualize", action: "visualize", query: job.subject, jobId: job.id, status: "running" });
    onActivity({ id: job.id, status: "done" });
    return {
      message: `Started a visualization of ${job.subject}${replaced ? ", replacing the previous one" : ""}; it builds in the background and appears in the Visualize tab (can take 15-60 min).`,
      isError: false,
    };
  };

  const server = createSdkMcpServer({
    name: VISUALIZE_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        VISUALIZE_TOOL,
        "Start building an interactive isometric figure, in the background (15-60 minutes), shown in the app's Visualize tab: how a physical object, mechanism or system works, or research findings turned into a physical figure (a gauge, counter, balance or machine encoding the key numbers). " +
          "There is one figure at a time: without `explicit` this does nothing while the current figure is still building; `explicit: true` replaces it. Once per turn.",
        {
          subject: z.string().min(1).max(200).describe("The object or mechanism to show, e.g. 'a dial indicator gauge'"),
          brief: z
            .string()
            .max(2000)
            .optional()
            .describe(
              "Structured facts to encode: 'Key numbers:' (value unit (date) — source host), 'Parts and relations:', 'Conflicts:', 'Object idea:' (one line)",
            ),
          explicit: z
            .boolean()
            .optional()
            .describe("true only when the user's own message explicitly asks to visualize, illustrate, diagram or draw something; replaces the current figure"),
        },
        async ({ subject, brief, explicit }) => {
          if (attempted) return text("Only one visualization per turn; this turn already has one.");
          attempted = true;
          const { message, isError } = begin({
            subject,
            ...(brief ? { brief } : {}),
            origin: "chat",
            explicit: explicit === true,
          });
          return text(message, isError);
        },
      ),
      ...tools,
    ],
  });

  return {
    server,
    /** the turn's figure is taken care of (a message reached the current one): no automatic start */
    claim() {
      attempted = true;
    },
    /** see each SDK message of the turn: research calls and results, and the answer's text */
    observe(message: unknown) {
      const m = message as { type?: string; message?: { content?: unknown } };
      if (!Array.isArray(m?.message?.content)) return;
      const blocks = m.message.content as Block[];
      if (m.type === "assistant") {
        for (const block of blocks) {
          if (block?.type === "tool_use" && block.name) {
            if (block.id) calls.set(block.id, block.name);
            if (researchTools.includes(block.name)) researched = true;
          } else if (block?.type === "text" && block.text) answer.push(block.text);
        }
      } else if (m.type === "user") {
        for (const block of blocks) {
          if (block?.type !== "tool_result" || !block.tool_use_id) continue;
          const name = calls.get(block.tool_use_id);
          if (!name || !researchTools.includes(name)) continue;
          (name === crossrefTool ? crossrefs : pages).push(resultText(block.content));
        }
      }
    },
    /**
     * After a turn that finished normally: a research turn that Claude did not
     * visualize gets its figure started now (unless one is still building).
     */
    finish(question: string) {
      if (!researched || attempted) return;
      attempted = true;
      begin({
        subject: subjectFrom(question) || "Research findings",
        brief: researchBrief({ question, answer: answer.join("\n\n"), pages, crossrefs }),
        origin: "research",
      });
    },
  };
}

export type VisualizeTurn = ReturnType<typeof createVisualizeTurn>;
