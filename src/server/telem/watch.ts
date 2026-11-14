import { ingestAll } from "./ingest";
import {
  DEFAULT_FREQUENCY,
  DEFAULT_TTL,
  monitors as sharedClient,
  telemConfigured,
  type Frequency,
  type Monitor,
  type MonitorsClient,
} from "./monitors";
import { findMonitor, readChatWatch, updateChatWatch, type WatchMonitor } from "./store";

/**
 * Watching a chat's topic with a Telem monitor, and keeping up with it.
 *
 *   - `watchTopic`: create a monitor (daily and for 7 days unless asked
 *     otherwise, with a modest per-day agent budget) and record it on the
 *     chat's server-side record (store.ts).
 *   - `autoWatch`: after a chat's first research turn, watch its question —
 *     once per chat, never when Telem is not configured.
 *   - the poller: while the dev server runs, every few minutes, read each
 *     watched monitor's changes on from its cursor (ingest.ts). It starts on
 *     the first watch or the first updates request, never at import.
 */

/**
 * The monitor's own budget, in US dollars, set right after create (PATCH
 * /agent). The field names are not in Telem's docs; these are the ones its
 * API accepts (checked live, 2026-11-14). Planning a monitor cost about $0.10
 * and its first run about $0.04. Lower caps backfire: at $0.10 a tick Telem
 * skipped a run on its own estimate ("degraded", budget_estimate), and at
 * $0.05 a chat the agent refused to answer.
 */
export const MODEST_BUDGET = { tick_budget_usd: 0.2, chat_budget_usd: 0.15, daily_budget_usd: 0.4 };

/** a question as a monitor query: one line, at most 300 characters (search providers refuse >400) */
export function topicOf(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= 300) return flat;
  const cut = flat.slice(0, 299);
  const space = cut.lastIndexOf(" ");
  return `${(space > 200 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type WatchResult = { monitor: Monitor; record: WatchMonitor; budgetNote?: string };

export async function watchTopic(
  {
    chatId,
    query,
    frequency = DEFAULT_FREQUENCY,
    ttl = DEFAULT_TTL,
    auto = false,
  }: { chatId: string; query: string; frequency?: Frequency; ttl?: string; auto?: boolean },
  { client = sharedClient(), dir }: { client?: MonitorsClient; dir?: string } = {},
): Promise<WatchResult> {
  const topic = topicOf(query);
  const monitor = await client.create({ query: topic, frequency, ttl, metadata: { app: "agent_research" } });
  let budgetNote: string | undefined;
  if (monitor.agent_state !== null) {
    try {
      await client.updateAgent(monitor.id, { budget: MODEST_BUDGET });
    } catch (error) {
      budgetNote = error instanceof Error ? error.message : String(error);
      console.warn("[telem] could not set the monitor's budget:", budgetNote);
    }
  }
  const record: WatchMonitor = {
    id: monitor.id,
    query: monitor.query ?? topic,
    frequency: monitor.frequency ?? frequency,
    auto,
    createdAt: monitor.created_at ?? new Date().toISOString(),
    cursor: 0,
  };
  await updateChatWatch(chatId, (watch) => {
    watch.monitors = [...watch.monitors.filter((m) => m.id !== record.id), record];
  }, dir);
  ensurePoller();
  return { monitor, record, ...(budgetNote ? { budgetNote } : {}) };
}

/** the chat's first research turn: watch its question, unless the chat already watches something */
export async function autoWatch(
  { chatId, question }: { chatId?: string; question: string },
  options: { client?: MonitorsClient; dir?: string; enabled?: boolean } = {},
): Promise<WatchResult | null> {
  const enabled = options.enabled ?? (telemConfigured() && process.env.TELEM_AUTO_WATCH !== "0");
  if (!enabled || !chatId || !question.trim()) return null;
  const watch = await readChatWatch(chatId, options.dir);
  if (watch.monitors.length > 0) return null;
  try {
    const result = await watchTopic({ chatId, query: question, auto: true }, options);
    console.info(`[telem] watching "${result.record.query}" for chat ${chatId} (${result.monitor.id})`);
    return result;
  } catch (error) {
    console.warn("[telem] auto-watch failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** a chat's monitor by id, or its newest live one */
export async function resolveMonitor(chatId: string | undefined, id?: string, dir?: string): Promise<WatchMonitor | { id: string } | null> {
  if (id) {
    const watch = chatId ? await readChatWatch(chatId, dir) : null;
    return watch?.monitors.find((m) => m.id === id) ?? { id };
  }
  if (!chatId) return null;
  const watch = await readChatWatch(chatId, dir);
  const live = watch.monitors.filter((m) => !m.deleted);
  return live[live.length - 1] ?? null;
}

/** delete a monitor on Telem and stop reading it (its findings stay) */
export async function endWatch(monitorId: string, { client = sharedClient(), dir }: { client?: MonitorsClient; dir?: string } = {}) {
  await client.delete(monitorId);
  const owner = await findMonitor(monitorId, dir);
  if (owner) {
    await updateChatWatch(owner.chatId, (watch) => {
      watch.monitors = watch.monitors.map((m) => (m.id === monitorId ? { ...m, deleted: true } : m));
    }, dir);
  }
}

/** ------------------------------------------------------------------ poller */

const POLL_MS = Math.max(60_000, Number(process.env.TELEM_POLL_MS) || 5 * 60_000);
const FIRST_PASS_MS = 20_000;

type PollerState = { timer?: ReturnType<typeof setInterval>; running: boolean; soon?: ReturnType<typeof setTimeout>[]; lastPass?: string };
const g = globalThis as typeof globalThis & { __telemWatchPoller?: PollerState };

async function pass() {
  const state = g.__telemWatchPoller;
  if (!state || state.running) return;
  state.running = true;
  try {
    const results = await ingestAll();
    const found = results.reduce((n, r) => n + r.findings.length, 0);
    if (found) console.info(`[telem] ingested ${found} new findings`);
  } catch (error) {
    console.warn("[telem] watch pass failed:", error instanceof Error ? error.message : error);
  } finally {
    state.running = false;
    state.lastPass = new Date().toISOString();
  }
}

/** start the background reads once, while this server runs; a no-op without Telem or under test */
export function ensurePoller() {
  if (!telemConfigured() || process.env.VITEST) return;
  if (g.__telemWatchPoller?.timer) return;
  const state: PollerState = (g.__telemWatchPoller ??= { running: false });
  state.timer = setInterval(() => void pass(), POLL_MS);
  state.timer.unref?.();
  const first = setTimeout(() => void pass(), FIRST_PASS_MS);
  first.unref?.();
}

/** after "run now": read again once the tick has likely finished, without waiting for the schedule */
export function ingestSoon(delays = [60_000, 180_000]) {
  if (!telemConfigured() || process.env.VITEST) return;
  ensurePoller();
  for (const delay of delays) {
    const timer = setTimeout(() => void pass(), delay);
    timer.unref?.();
  }
}

export function pollerStatus() {
  return { running: Boolean(g.__telemWatchPoller?.timer), lastPass: g.__telemWatchPoller?.lastPass ?? null, everyMs: POLL_MS };
}
