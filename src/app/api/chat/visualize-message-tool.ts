import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { formatElapsed, isActive, type JobDetail, type JobStatus } from "@/lib/visualize";
import { MAX_MESSAGE, getRunner, type MessageResult } from "@/server/visualize/runner";

import { VISUALIZE_SERVER } from "./visualize-tool";

/**
 * The chat's line to the Visualize agent, on the `visualize` server beside the
 * visualize tool:
 *
 *   - `message_visualize` sends the user's change request to the agent behind
 *     the CURRENT visualization: straight into its session while it is
 *     building (it reads it between tool calls), or — once it has ended — by
 *     resuming that session in the same job (src/server/visualize/runner.ts).
 *     It returns at once and reports a `Visualize` row (action
 *     "visualize-message") that follows the job like a visualize row does.
 *   - `visualize_status` (read-only) says what the current visualization is
 *     doing: subject, status, elapsed time, the agent's last reply, and its
 *     latest progress lines.
 */

export const MESSAGE_VISUALIZE_TOOL = "message_visualize";
export const VISUALIZE_STATUS_TOOL = "visualize_status";
export const MESSAGE_VISUALIZE_TOOL_ID = `mcp__${VISUALIZE_SERVER}__${MESSAGE_VISUALIZE_TOOL}`;
export const VISUALIZE_STATUS_TOOL_ID = `mcp__${VISUALIZE_SERVER}__${VISUALIZE_STATUS_TOOL}`;

/** appended to the chat's system prompt, after VISUALIZE_PROMPT */
export const VISUALIZE_MESSAGE_PROMPT = [
  "Talking to the Visualize agent:",
  "- When the user asks to change, adjust, fix or annotate the current figure (colours, labels, a caption, the view angle, a part, exploding it, wording…), call message_visualize with their request, written as a clear instruction for the agent building the figure. It reaches the agent while it is still building, or picks a finished figure back up; either way the same figure is updated. Don't call visualize for this: start a new visualization only when the user explicitly asks for a new or different one.",
  "- message_visualize returns at once: say in one sentence that the Visualize agent is applying it; don't describe the change as done.",
  "- When the user asks how the figure is going or what the agent changed, call visualize_status and answer from it.",
].join("\n");

export type VisualizeMessageActivity =
  | { id: string; name: "Visualize"; action: "visualize-message"; query: string; jobId?: string; status: "running" }
  | { id: string; status: "done" }
  | { id: string; status: "error"; message: string };

export type SendMessage = (message: string) => MessageResult;
export type CurrentJob = (lines: number) => JobDetail | null;

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const STATUS_WORD: Record<JobStatus, string> = {
  queued: "queued",
  running: "building",
  done: "done",
  error: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
};

/** the current visualization, for Claude: one short block */
export function describeStatus(job: JobDetail | null): string {
  if (!job) return "There is no visualization yet. Start one with visualize if the user wants a figure.";
  const lines = [
    `Subject: ${job.subject}`,
    `Status: ${STATUS_WORD[job.status]}${job.startedAt !== undefined ? ` (${isActive(job.status) ? "running for" : "ran"} ${formatElapsed(job.elapsedMs)})` : ""}`,
    ...(job.figure ? [`Figure: ${isActive(job.status) ? "the previous version is kept while it rebuilds" : "ready in the Visualize tab"}`] : []),
    ...(job.error ? [`Problem: ${job.error}`] : []),
    ...(job.note ? [`Note: ${job.note}`] : []),
    ...(job.messages ? [`Messages from the chat so far: ${job.messages}`] : []),
    ...(job.lastReply ? [`Agent's last reply: ${job.lastReply}`] : []),
  ];
  if (job.log.length) lines.push("", "Latest progress:", ...job.log.map((line) => `- ${line.text}`));
  return lines.join("\n");
}

export function createVisualizeMessageTools({
  onActivity,
  onSent = () => {},
  send = (message) => getRunner().sendMessage(message),
  current = (lines) => getRunner().currentJob(lines),
}: {
  onActivity: (activity: VisualizeMessageActivity) => void;
  /** a message reached the agent: this turn has its visualization */
  onSent?: () => void;
  send?: SendMessage;
  current?: CurrentJob;
}) {
  return [
    tool(
      MESSAGE_VISUALIZE_TOOL,
      "Send a change request to the Visualize agent behind the current figure (the one in the Visualize tab): it applies it to that same figure — mid-build if it is still building, or by picking the finished figure back up. " +
        "Use it whenever the user wants the current figure changed (colours, labels, caption, view, parts, wording). Returns at once; the update shows in the Visualize tab when the agent is done.",
      {
        message: z
          .string()
          .min(1)
          .max(MAX_MESSAGE)
          .describe("The change, as a clear instruction for the agent, e.g. 'Make the bell dome blue and label the striker.'"),
      },
      async ({ message }) => {
        const id = crypto.randomUUID();
        const query = message.replace(/\s+/g, " ").trim();
        let result: MessageResult;
        try {
          result = send(message);
        } catch (error) {
          const reason = `Couldn't reach the Visualize agent: ${error instanceof Error ? error.message : String(error)}`;
          onActivity({ id, name: "Visualize", action: "visualize-message", query, status: "running" });
          onActivity({ id, status: "error", message: reason });
          return text(reason, true);
        }
        if (result.status === "none") {
          return text(
            "There is no visualization to message: nothing has been visualized yet. If the user wants a figure, call visualize (explicit: true) with their request instead.",
          );
        }
        const { job } = result;
        onActivity({ id, name: "Visualize", action: "visualize-message", query, jobId: job.id, status: "running" });
        if (result.status === "unavailable") {
          onActivity({ id, status: "error", message: result.reason });
          return text(`Couldn't send it to the Visualize agent for "${job.subject}": ${result.reason}`, true);
        }
        onActivity({ id, status: "done" });
        onSent();
        return text(
          result.status === "live"
            ? `Sent to the Visualize agent; it's applying it now, while it builds "${job.subject}". The updated figure shows in the Visualize tab when it is done.`
            : `Sent to the Visualize agent; it's applying it now: it picked the finished figure of "${job.subject}" back up and is updating it (usually a few minutes). The updated figure shows in the Visualize tab when it is done.`,
        );
      },
    ),
    tool(
      VISUALIZE_STATUS_TOOL,
      "Read-only: the current visualization's subject, status, elapsed time, the Visualize agent's last reply (what it changed) and its latest progress lines.",
      {},
      async () => text(describeStatus(current(8))),
    ),
  ];
}
