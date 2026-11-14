import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  FREQUENCIES,
  chatReply,
  monitors as sharedClient,
  waitForJob,
  type MonitorsClient,
} from "@/server/telem/monitors";
import { readChatWatch } from "@/server/telem/store";
import { ingestSoon, resolveMonitor, watchTopic } from "@/server/telem/watch";

/**
 * Telem Monitors as the chat's tools: watch a topic, check on a watch, talk
 * to a monitor's own agent, pause, resume or run it now. Each call is one
 * `tool` row in the chat — name "Telem", action "watch", the row's line in
 * `query` ("Watching <topic>", "Asking <topic>" …) — and none reports counts.
 *
 * `id` is optional everywhere but watch_topic: without it a tool acts on the
 * chat's newest monitor (the one its first research turn started).
 */

export const TELEM_WATCH_SERVER = "telem_watch";
export const TELEM_WATCH_TOOLS = [
  "watch_topic",
  "monitor_status",
  "ask_monitor",
  "pause_monitor",
  "resume_monitor",
  "run_monitor_now",
] as const;
export const TELEM_WATCH_TOOL_IDS = TELEM_WATCH_TOOLS.map((name) => `mcp__${TELEM_WATCH_SERVER}__${name}`);

export const TELEM_WATCH_PROMPT = [
  "Telem Monitors (watching the web over time):",
  "- After a chat's first research turn, the app starts a daily Telem monitor on its question by itself; don't call watch_topic for that.",
  "- Call watch_topic only when the user asks to watch, track, follow or be alerted about something more. Default frequency 1d; use 1h/6h only if asked.",
  "- monitor_status reports what a monitor found; ask_monitor sends a question to the monitor's own agent and returns its answer (use it when the user asks what the watch found, or to change what it tracks).",
  "- pause_monitor / resume_monitor / run_monitor_now when the user asks. Mention a watch in one short sentence at most.",
].join("\n");

export type WatchActivity =
  | { id: string; name: "Telem"; action: "watch"; query: string; status: "running" }
  | { id: string; status: "done" }
  | { id: string; status: "error"; message: string };

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const short = (value: string, max = 80) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const money = (usd: unknown) => (typeof usd === "number" ? `$${usd.toFixed(usd < 1 ? 3 : 2)}` : "unknown");

export function createTelemWatchServer({
  chatId,
  onActivity,
  signal,
  client = sharedClient(),
  dir,
}: {
  chatId?: string;
  onActivity: (activity: WatchActivity) => void;
  signal?: AbortSignal;
  client?: MonitorsClient;
  dir?: string;
}) {
  /** run one tool call as one row: running, then done or error */
  async function row(line: string, work: () => Promise<string>) {
    const id = crypto.randomUUID();
    onActivity({ id, name: "Telem", action: "watch", query: line, status: "running" });
    try {
      const result = await work();
      onActivity({ id, status: "done" });
      return text(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onActivity({ id, status: "error", message });
      return text(`Telem failed: ${message}`, true);
    }
  }

  /** the monitor a call is about, and its topic for the row */
  async function target(id: string | undefined) {
    const found = await resolveMonitor(chatId, id, dir);
    if (!found) throw new Error("This chat isn't watching anything yet; call watch_topic first.");
    const query = "query" in found ? found.query : (await client.get(found.id)).query;
    return { id: found.id, query };
  }

  const idArg = z.string().max(80).optional().describe("The monitor's id; leave out for this chat's newest monitor");

  const server = createSdkMcpServer({
    name: TELEM_WATCH_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "watch_topic",
        "Start a Telem monitor: an agent that searches the web for this topic on a schedule, keeps what matches, and feeds new sources into this chat's Knowledge base and the vault. Costs a little per run.",
        {
          query: z.string().min(3).max(300).describe("What to watch for, as one plain sentence"),
          frequency: z.enum(FREQUENCIES as unknown as [string, ...string[]]).optional().describe("1h, 6h, 12h, 1d (default) or 7d"),
        },
        async ({ query, frequency }) => {
          if (!chatId) return text("No chat to attach the watch to.", true);
          return row(`Watching ${short(query)}`, async () => {
            const { monitor, record } = await watchTopic(
              { chatId, query, frequency: (frequency as (typeof FREQUENCIES)[number]) ?? undefined },
              { client, dir },
            );
            return `Watching "${record.query}" (${record.frequency}, monitor ${monitor.id}, ends ${monitor.expires_at ?? "never"}). New finds appear in the Knowledge base and the Telem tab.`;
          });
        },
      ),
      tool(
        "monitor_status",
        "What a Telem monitor is doing and what it found: status, schedule, spend, its latest objects and changes. Without id, every monitor this chat watches.",
        { id: idArg },
        async ({ id }) => {
          if (!id && chatId) {
            const watch = await readChatWatch(chatId, dir);
            if (watch.monitors.filter((m) => !m.deleted).length > 1) {
              const lines = watch.monitors.filter((m) => !m.deleted).map((m) => `- ${m.id}: ${m.query} (${m.frequency})`);
              return row("Checking the watches", async () => `This chat watches:\n${lines.join("\n")}\nCall monitor_status with an id for one.`);
            }
          }
          let topic = "";
          try {
            topic = (await target(id)).query;
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
          return row(`Checking ${short(topic)}`, async () => {
            const { id: monitorId } = await target(id);
            const [monitor, agent, objects, changes] = await Promise.all([
              client.get(monitorId),
              client.agent(monitorId).catch(() => null),
              client.objects(monitorId, { limit: 12 }).catch(() => null),
              client.events(monitorId, { limit: 12 }).catch(() => null),
            ]);
            const lines = [
              `Monitor ${monitor.id}: "${monitor.query}"`,
              `Status ${monitor.status}, agent ${agent?.status ?? monitor.agent_state?.status ?? "none"}, every ${monitor.frequency}, ends ${monitor.expires_at ?? "never"}.`,
              `Next run ${agent?.next_tick_at ?? monitor.agent_state?.next_run_at ?? "unscheduled"}; spent ${money(agent?.spend_usd)}.`,
            ];
            if (objects?.objects?.length) {
              lines.push("Found:");
              for (const o of objects.objects) lines.push(`- ${o.name} [${o.status}]${o.urls?.[0] ? ` ${o.urls[0]}` : ""}`);
            } else lines.push("No objects yet (the agent may still be planning or on its first run).");
            if (changes?.events?.length) {
              lines.push("Latest events:");
              for (const e of changes.events.slice(0, 8)) lines.push(`- tick ${e.tick} ${e.kind}${e.identity_key ? ` ${e.identity_key}` : ""}`);
            }
            return lines.join("\n");
          });
        },
      ),
      tool(
        "ask_monitor",
        "Send a message to a Telem monitor's own agent and return its answer: ask what it found, or ask it to change what it tracks (it may add sources or panels). Takes up to ~90 s.",
        { id: idArg, message: z.string().min(1).max(4000) },
        async ({ id, message }) => {
          let found;
          try {
            found = await target(id);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
          return row(`Asking ${short(found.query)}`, async () => {
            const sent = await client.chat(found.id, message);
            const job = await waitForJob(client, found.id, sent.job_id, { signal });
            if (job.status === "failed") throw new Error(job.error ?? "the monitor's agent could not answer");
            const messages = (await client.chatMessages(found.id, 20).catch(() => ({ messages: [] }))).messages;
            const reply = chatReply(job, messages);
            if (job.status !== "done") return `The monitor's agent is still working on it (job ${job.id}); its answer will show in the Telem tab.`;
            return reply ? `The monitor's agent answered:\n${reply}` : "The monitor's agent finished without a text answer.";
          });
        },
      ),
      ...(["pause", "resume"] as const).map((verb) =>
        tool(
          `${verb}_monitor`,
          verb === "pause" ? "Pause a Telem monitor's schedule (it stops running and billing)." : "Resume a paused Telem monitor.",
          { id: idArg },
          async ({ id }) => {
            let found;
            try {
              found = await target(id);
            } catch (error) {
              return text(error instanceof Error ? error.message : String(error), true);
            }
            return row(`${verb === "pause" ? "Paused" : "Resumed"} ${short(found.query)}`, async () => {
              const monitor = await client.update(found.id, { status: verb === "pause" ? "paused" : "active" });
              return `Monitor ${monitor.id} is ${monitor.status}.`;
            });
          },
        ),
      ),
      tool(
        "run_monitor_now",
        "Run a Telem monitor's agent once now, outside its schedule. Its finds show up in a few minutes.",
        { id: idArg },
        async ({ id }) => {
          let found;
          try {
            found = await target(id);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
          return row(`Running ${short(found.query)}`, async () => {
            const { job_id } = await client.runNow(found.id);
            ingestSoon();
            return `Started a run (job ${job_id}); its finds come into the Knowledge base and the Telem tab in a few minutes.`;
          });
        },
      ),
    ],
  });

  return server;
}
