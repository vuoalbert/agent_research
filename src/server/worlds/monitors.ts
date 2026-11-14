// Ported from nyc-world by menonsprithvi-web (server.mjs @ a4e4a44, /api/watch),
// on the app's shared Telem Monitors client (src/server/telem/monitors.ts).

import { monitors as sharedClient, type MonitorsClient } from "@/server/telem/monitors";
import { MODEST_BUDGET } from "@/server/telem/watch";

import { TRUST_MIN, normUrl, trustOf, type Trust } from "./telem";

/**
 * "Watch this topic" for a World Labs label: a Telem Monitor on the label's
 * topic, hourly for seven days, with the app's modest agent budget; a poll
 * returns what is new since the last poll, kept to trustworthy sources (the
 * badge on the label).
 */

export const WATCH_FREQUENCY = "1h";
export const WATCH_TTL = "7d";

type Client = Pick<MonitorsClient, "create" | "updateAgent" | "poll" | "delete">;

export type Watch = { id: string; status: string; frequency: string; expires_at: string | null; budgetNote?: string };

export async function createWatch(query: string, { client = sharedClient() }: { client?: Client } = {}): Promise<Watch> {
  const m = await client.create({ query: query.slice(0, 300), frequency: WATCH_FREQUENCY, ttl: WATCH_TTL, metadata: { app: "agent_research", view: "world" } });
  let budgetNote: string | undefined;
  if (m.agent_state !== null) {
    try {
      await client.updateAgent(m.id, { budget: MODEST_BUDGET });
    } catch (error) {
      budgetNote = error instanceof Error ? error.message : String(error);
      console.warn("[world] could not set the monitor's budget:", budgetNote);
    }
  }
  return { id: m.id, status: m.status, frequency: m.frequency, expires_at: m.expires_at ?? null, ...(budgetNote ? { budgetNote } : {}) };
}

export type WatchFind = { url: string; title: string; provider: string; trust: Trust };
export type WatchPoll = { id: string; new_results: WatchFind[]; total: number; warnings: string[] };

type PollRun = { preprocessor_name?: string; output_payload?: { results?: { url?: string; title?: string }[]; warnings?: unknown[] } };
const warningText = (w: unknown) => (typeof w === "string" ? w : String((w as { code?: unknown })?.code ?? JSON.stringify(w)));

export async function pollWatch(id: string, { client = sharedClient() }: { client?: Client } = {}): Promise<WatchPoll> {
  const out = (await client.poll(id)) as { preprocessor_runs?: PollRun[]; warnings?: unknown };
  const warnings: string[] = [];
  const results: WatchFind[] = [];
  for (const run of out.preprocessor_runs ?? []) {
    warnings.push(...(run.output_payload?.warnings ?? []).map(warningText));
    for (const r of run.output_payload?.results ?? []) {
      if (r?.url) results.push({ url: r.url, title: r.title || r.url, provider: run.preprocessor_name ?? "", trust: trustOf(r.url) });
    }
  }
  if (out.warnings) warnings.push(...([] as unknown[]).concat(out.warnings).map(warningText));
  const seen = new Set<string>();
  const fresh = results.filter((r) => {
    const k = normUrl(r.url);
    if (r.trust.score < TRUST_MIN || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { id, new_results: fresh, total: results.length, warnings: [...new Set(warnings)].filter(Boolean) };
}

export async function deleteWatch(id: string, { client = sharedClient() }: { client?: Client } = {}): Promise<void> {
  await client.delete(id);
}
