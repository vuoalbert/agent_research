import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  summarizeAll,
  summarizeChat,
  type AllUsage,
  type ChatUsage,
  type ClaudeUsageRecord,
  type JobUsageRecord,
  type TelemUsageRecord,
  type UsageRecord,
} from "@/lib/telem-usage";

import { onTelemCall, type TelemCallMeta } from "./events";
import { estimateTelemCost, isFallback } from "./pricing";

/**
 * The usage recorder: every Telem call (via events.ts), every Agent SDK run's
 * `result` (the chat's turn and each subagent), and every Visualize/World job
 * started, appended per chat to `/.telem/usage/<chatId>.jsonl` (git-ignored;
 * `TELEM_USAGE_DIR` moves it). Append-only: the usage route re-reads the
 * files and summarizes them (src/lib/telem-usage.ts).
 *
 * A failed write is logged and dropped — telemetry never breaks a turn.
 */

/** records with no chat (a graph chat, a monitor) */
export const UNSCOPED = "_unscoped";

export function usageDir(): string {
  return resolve(process.env.TELEM_USAGE_DIR || join(process.cwd(), ".telem", "usage"));
}

/** a chat id as a file name: anything but [A-Za-z0-9_-] becomes "_" */
export function fileFor(chatId: string | undefined): string {
  const safe = (chatId || UNSCOPED).replace(/[^\w-]/g, "_").slice(0, 200);
  return `${safe || UNSCOPED}.jsonl`;
}

export type UsageStore = {
  dir: string;
  append(record: UsageRecord): void;
  /** resolves once every append so far is on disk */
  flush(): Promise<void>;
  /** read and readAll wait for the appends before them */
  read(chatId: string): Promise<UsageRecord[]>;
  readAll(): Promise<Map<string, UsageRecord[]>>;
};

function parseLines(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as UsageRecord;
      if (value && (value.t === "telem" || value.t === "claude" || value.t === "job") && typeof value.at === "number") {
        records.push(value);
      }
    } catch {
      // a torn last line from a crash: skip it
    }
  }
  return records;
}

export function createUsageStore(dir: string = usageDir()): UsageStore {
  /** one write chain per file, so lines never interleave */
  const chains = new Map<string, Promise<void>>();
  let made: Promise<unknown> | null = null;
  const flush = async () => {
    await Promise.all(chains.values());
  };

  return {
    dir,
    append(record) {
      const file = join(dir, fileFor(record.chatId));
      made ??= mkdir(dir, { recursive: true });
      const next = (chains.get(file) ?? Promise.resolve())
        .then(() => made)
        .then(() => appendFile(file, `${JSON.stringify(record)}\n`))
        .catch((error) => console.warn("[telem] usage write failed:", error instanceof Error ? error.message : error));
      chains.set(file, next);
    },
    flush,
    async read(chatId) {
      await flush();
      try {
        return parseLines(await readFile(join(dir, fileFor(chatId)), "utf8"));
      } catch {
        return [];
      }
    },
    async readAll() {
      await flush();
      const byChat = new Map<string, UsageRecord[]>();
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
      } catch {
        return byChat;
      }
      for (const name of names) {
        const records = parseLines(await readFile(join(dir, name), "utf8").catch(() => ""));
        if (!records.length) continue;
        // the chat id as recorded, not the file name it was squeezed into
        byChat.set(records[0].chatId || name.replace(/\.jsonl$/, ""), records);
      }
      return byChat;
    },
  };
}

/** a Telem call as the line it is stored as */
export function telemRecordFrom(meta: TelemCallMeta): TelemUsageRecord {
  const { costUsd, source } = estimateTelemCost(meta);
  return {
    t: "telem",
    at: meta.at ?? Date.now(),
    chatId: meta.chatId || UNSCOPED,
    kind: meta.kind,
    providers: meta.providers,
    ...(meta.runs?.length
      ? { runs: meta.runs.map(({ provider, status, latencyMs, costUsd: c }) => ({ provider, status, latencyMs, costUsd: c })) }
      : {}),
    latencyMs: meta.latencyMs,
    status: meta.status,
    ...(meta.error ? { error: meta.error } : {}),
    ...(meta.tier ? { tier: meta.tier } : {}),
    costUsd,
    costSource: source,
    ...(isFallback(meta) ? { fallback: true } : {}),
    ...(meta.query ? { query: meta.query.slice(0, 300) } : meta.urls?.length ? { query: meta.urls.join(" ").slice(0, 300) } : {}),
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta.trajectoryId ? { trajectoryId: meta.trajectoryId } : {}),
    ...(meta.parentTrajectoryId ? { parentTrajectoryId: meta.parentTrajectoryId } : {}),
    ...(meta.interactionId ? { interactionId: meta.interactionId } : {}),
    ...(meta.turn !== undefined ? { turn: meta.turn } : {}),
    agent: meta.agent || "main",
    ...(meta.callId ? { callId: meta.callId } : {}),
  };
}

/** the fields of an Agent SDK `result` message the recorder reads */
type ResultLike = {
  type: "result";
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
};

const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function claudeRecordFrom(
  message: ResultLike,
  { chatId, agent = "main", title, turn }: { chatId?: string; agent?: string; title?: string; turn?: number },
): ClaudeUsageRecord {
  // modelUsage covers every model call of the run; `usage` only the main loop
  const models = Object.values(message.modelUsage ?? {});
  const tokens = models.length
    ? {
        inputTokens: models.reduce((t, m) => t + n(m.inputTokens), 0),
        outputTokens: models.reduce((t, m) => t + n(m.outputTokens), 0),
        cacheReadTokens: models.reduce((t, m) => t + n(m.cacheReadInputTokens), 0),
        cacheWriteTokens: models.reduce((t, m) => t + n(m.cacheCreationInputTokens), 0),
      }
    : {
        inputTokens: n(message.usage?.input_tokens),
        outputTokens: n(message.usage?.output_tokens),
        cacheReadTokens: n(message.usage?.cache_read_input_tokens),
        cacheWriteTokens: n(message.usage?.cache_creation_input_tokens),
      };
  return {
    t: "claude",
    at: Date.now(),
    chatId: chatId || UNSCOPED,
    agent,
    ...(title ? { title } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ok: message.subtype === "success",
    costUsd: n(message.total_cost_usd),
    ...tokens,
    ...(message.duration_ms !== undefined ? { durationMs: n(message.duration_ms) } : {}),
    ...(message.num_turns !== undefined ? { numTurns: n(message.num_turns) } : {}),
  };
}

// ── the process-wide recorder ────────────────────────────────────────────────

const KEY = Symbol.for("agent_research.telem.usage");
type Holder = { [KEY]?: { store: UsageStore; stop: () => void } };

/** start recording Telem calls (once per process); returns the store */
export function startUsageRecorder(store?: UsageStore): UsageStore {
  const holder = globalThis as Holder;
  if (holder[KEY] && !store) return holder[KEY].store;
  holder[KEY]?.stop();
  const active = store ?? createUsageStore();
  const stop = onTelemCall((meta) => active.append(telemRecordFrom(meta)));
  holder[KEY] = { store: active, stop };
  return active;
}

/** stop and forget the recorder (tests) */
export function stopUsageRecorder(): void {
  const holder = globalThis as Holder;
  holder[KEY]?.stop();
  delete holder[KEY];
}

/** an Agent SDK run finished: the chat's turn (`agent: "main"`) or a subagent */
export function recordClaudeResult(message: ResultLike, context: Parameters<typeof claudeRecordFrom>[1]): void {
  try {
    startUsageRecorder().append(claudeRecordFrom(message, context));
  } catch (error) {
    console.warn("[telem] usage record failed:", error instanceof Error ? error.message : error);
  }
}

export function recordJob(chatId: string | undefined, kind: JobUsageRecord["kind"], jobId: string, turn?: number): void {
  startUsageRecorder().append({
    t: "job",
    at: Date.now(),
    chatId: chatId || UNSCOPED,
    kind,
    jobId,
    ...(turn !== undefined ? { turn } : {}),
  });
}

export async function chatUsage(chatId: string, store: UsageStore = startUsageRecorder()): Promise<ChatUsage> {
  return summarizeChat(chatId, await store.read(chatId));
}

export async function allUsage(store: UsageStore = startUsageRecorder()): Promise<AllUsage> {
  return summarizeAll(await store.readAll());
}
