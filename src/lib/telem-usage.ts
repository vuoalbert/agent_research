/**
 * Usage telemetry: the records src/server/telem/usage.ts appends per chat, and
 * the summaries GET /api/telem/usage builds from them for the Telem tab.
 * Pure — no fs, so the UI and the tests share it with the server.
 *
 * Three kinds of record, one JSON line each:
 *   telem   one Telem search or fetch: providers, latency, status, cost, lineage
 *   claude  one Agent SDK run's `result`: the chat's own turn, or a subagent's
 *   job     a Visualize (or World) job started
 */

export const TELEM_CONSOLE_URL = "https://app.telem.ai/";

export type TelemRunRecord = { provider: string; status: string; latencyMs?: number; costUsd?: number };

export type TelemUsageRecord = {
  t: "telem";
  at: number;
  chatId: string;
  kind: "search" | "fetch";
  providers: string[];
  runs?: TelemRunRecord[];
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
  tier?: string;
  costUsd: number;
  /** Telem said what it cost, or we priced it from docs.telem.ai/pricing */
  costSource: "actual" | "estimated";
  /** a provider failed and another answered in its place */
  fallback?: boolean;
  query?: string;
  sessionId?: string;
  trajectoryId?: string;
  parentTrajectoryId?: string;
  interactionId?: string;
  turn?: number;
  agent: string;
  callId?: string;
};

export type ClaudeUsageRecord = {
  t: "claude";
  at: number;
  chatId: string;
  /** "main", or the subagent's id */
  agent: string;
  title?: string;
  turn?: number;
  ok: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs?: number;
  numTurns?: number;
};

export type JobUsageRecord = { t: "job"; at: number; chatId: string; kind: "visualize" | "world"; jobId: string; turn?: number };

export type UsageRecord = TelemUsageRecord | ClaudeUsageRecord | JobUsageRecord;

export type ProviderShare = { provider: string; calls: number; share: number; costUsd: number };

export type AgentNode = {
  agent: string;
  title: string;
  searches: number;
  fetches: number;
  failures: number;
  telemCostUsd: number;
  claudeCostUsd: number;
  sessionIds: string[];
  trajectoryIds: string[];
};

export type UsageTotals = {
  searches: number;
  fetches: number;
  failures: number;
  fallbacks: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  telemCostUsd: number;
  /** some of the Telem cost was priced from the docs, not reported */
  telemCostEstimated: boolean;
  claudeTurns: number;
  subagentRuns: number;
  claudeCostUsd: number;
  claudeTokens: number;
  visualizeJobs: number;
  worldJobs: number;
};

export type ChatUsage = {
  chatId: string;
  totals: UsageTotals;
  providers: ProviderShare[];
  /** main first, then its subagents in the order they first called Telem */
  tree: { main: AgentNode; subagents: AgentNode[] };
  sessionIds: string[];
  firstAt: number | null;
  lastAt: number | null;
};

export type DayUsage = { day: string; searches: number; fetches: number; telemCostUsd: number; claudeCostUsd: number };

export type AllUsage = {
  totals: UsageTotals;
  providers: ProviderShare[];
  days: DayUsage[];
  chats: { chatId: string; telemCalls: number; telemCostUsd: number; claudeCostUsd: number; lastAt: number | null }[];
};

/** nearest-rank percentile of an unsorted list; null for none */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const isTelem = (r: UsageRecord): r is TelemUsageRecord => r.t === "telem";
const isClaude = (r: UsageRecord): r is ClaudeUsageRecord => r.t === "claude";

export function totalsOf(records: readonly UsageRecord[]): UsageTotals {
  const telem = records.filter(isTelem);
  const claude = records.filter(isClaude);
  const latencies = telem.filter((r) => r.status === "ok").map((r) => r.latencyMs);
  return {
    searches: telem.filter((r) => r.kind === "search").length,
    fetches: telem.filter((r) => r.kind === "fetch").length,
    failures: telem.filter((r) => r.status === "error").length,
    fallbacks: telem.filter((r) => r.fallback).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    telemCostUsd: sum(telem.map((r) => r.costUsd)),
    telemCostEstimated: telem.some((r) => r.costSource === "estimated" && r.costUsd > 0),
    claudeTurns: claude.filter((r) => r.agent === "main").length,
    subagentRuns: claude.filter((r) => r.agent !== "main").length,
    claudeCostUsd: sum(claude.map((r) => r.costUsd)),
    claudeTokens: sum(claude.map((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens)),
    visualizeJobs: records.filter((r) => r.t === "job" && r.kind === "visualize").length,
    worldJobs: records.filter((r) => r.t === "job" && r.kind === "world").length,
  };
}

/** each provider's share of the provider runs that answered, largest first */
export function providerShares(records: readonly UsageRecord[]): ProviderShare[] {
  const byProvider = new Map<string, { calls: number; costUsd: number }>();
  for (const record of records.filter(isTelem)) {
    if (record.status !== "ok") continue;
    const answered = record.providers.length > 0 ? record.providers : [];
    // a call's cost is split evenly over the providers that answered it
    const each = answered.length ? record.costUsd / answered.length : 0;
    for (const provider of answered) {
      const entry = byProvider.get(provider) ?? { calls: 0, costUsd: 0 };
      entry.calls += 1;
      entry.costUsd += each;
      byProvider.set(provider, entry);
    }
  }
  const total = sum([...byProvider.values()].map((e) => e.calls));
  return [...byProvider.entries()]
    .map(([provider, e]) => ({ provider, calls: e.calls, share: total ? e.calls / total : 0, costUsd: e.costUsd }))
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
}

function node(agent: string, title: string): AgentNode {
  return { agent, title, searches: 0, fetches: 0, failures: 0, telemCostUsd: 0, claudeCostUsd: 0, sessionIds: [], trajectoryIds: [] };
}

const addOnce = (list: string[], value?: string) => {
  if (value && !list.includes(value)) list.push(value);
};

/** main → subagents, from each record's `agent` */
export function researchTree(records: readonly UsageRecord[]): ChatUsage["tree"] {
  const main = node("main", "Agent Research");
  const subs = new Map<string, AgentNode>();
  const of = (agent: string) => {
    if (agent === "main") return main;
    let sub = subs.get(agent);
    if (!sub) subs.set(agent, (sub = node(agent, "Subagent")));
    return sub;
  };
  for (const record of records) {
    if (record.t === "job") continue;
    const target = of(record.agent || "main");
    if (record.t === "claude") {
      target.claudeCostUsd += record.costUsd;
      if (record.title) target.title = record.title;
      continue;
    }
    if (record.kind === "search") target.searches += 1;
    else target.fetches += 1;
    if (record.status === "error") target.failures += 1;
    target.telemCostUsd += record.costUsd;
    addOnce(target.sessionIds, record.sessionId);
    addOnce(target.trajectoryIds, record.trajectoryId);
  }
  return { main, subagents: [...subs.values()] };
}

export function summarizeChat(chatId: string, records: readonly UsageRecord[]): ChatUsage {
  const sessionIds: string[] = [];
  for (const record of records) if (record.t === "telem") addOnce(sessionIds, record.sessionId);
  const times = records.map((r) => r.at);
  return {
    chatId,
    totals: totalsOf(records),
    providers: providerShares(records),
    tree: researchTree(records),
    sessionIds,
    firstAt: times.length ? Math.min(...times) : null,
    lastAt: times.length ? Math.max(...times) : null,
  };
}

/** UTC calendar day, YYYY-MM-DD */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function summarizeAll(byChat: ReadonlyMap<string, readonly UsageRecord[]>): AllUsage {
  const all = [...byChat.values()].flat();
  const days = new Map<string, DayUsage>();
  for (const record of all) {
    const day = dayOf(record.at);
    const entry = days.get(day) ?? { day, searches: 0, fetches: 0, telemCostUsd: 0, claudeCostUsd: 0 };
    if (record.t === "telem") {
      if (record.kind === "search") entry.searches += 1;
      else entry.fetches += 1;
      entry.telemCostUsd += record.costUsd;
    } else if (record.t === "claude") entry.claudeCostUsd += record.costUsd;
    days.set(day, entry);
  }
  return {
    totals: totalsOf(all),
    providers: providerShares(all),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    chats: [...byChat.entries()]
      .map(([chatId, records]) => {
        const telem = records.filter(isTelem);
        const times = records.map((r) => r.at);
        return {
          chatId,
          telemCalls: telem.length,
          telemCostUsd: sum(telem.map((r) => r.costUsd)),
          claudeCostUsd: sum(records.filter(isClaude).map((r) => r.costUsd)),
          lastAt: times.length ? Math.max(...times) : null,
        };
      })
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
  };
}

/**
 * The Telem console. It documents no deep link to a session or trajectory, so
 * the link opens the console and the id travels in its label and tooltip.
 */
export function consoleUrl(): string {
  return TELEM_CONSOLE_URL;
}

/** $0.0123 → "$0.012", $1.5 → "$1.50", 0 → "$0" */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toPrecision(2).replace(/0+$/, "")}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** 840 → "840 ms", 1234 → "1.2 s" */
export function formatMs(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
