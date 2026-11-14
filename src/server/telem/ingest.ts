import { writeWatchFindings, type WatchLogEntry } from "@/server/vault/watch";

import { monitors as sharedClient, type AgentObject, type Change, type MonitorsClient } from "./monitors";
import { listChatWatches, updateChatWatch, type WatchFinding, type WatchMonitor, type WatchSource } from "./store";

/**
 * Turning a monitor's change stream into the chat's news. For each monitor a
 * chat watches, read `/agent/changes` on from the stored cursor (oldest first,
 * never twice), keep the changes worth showing as findings, collect the pages
 * they came from as the chat's new sources, and log them in the vault. The
 * cursor is only stored once that is done, so a failed pass reads the same
 * changes again next time.
 *
 * Changes carry an object's name but not its pages; one `objects` read per
 * pass (a GET, which does not count toward Telem's per-minute limit) maps
 * names to their URLs.
 */

/** the most change pages one pass reads per monitor (200 changes a page) */
const MAX_PAGES = 3;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;

/** a change's `after`/`before` as a short readable value */
function valueOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return str(value);
  const v = value as Record<string, unknown>;
  return str(v.value) ?? str(v.status) ?? str(v.message) ?? str(v.text) ?? str(v.summary);
}

const urlIn = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const url = (value as Record<string, unknown>).url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
};

/** one change as a finding, or null for one that is only bookkeeping (a run, a plan change) */
export function findingOf(change: Change, monitorId: string, urls: ReadonlyMap<string, string>, now: string): WatchFinding | null {
  const name = str(change.subject?.name);
  const url = urlIn(change.after) ?? (name ? urls.get(name.toLowerCase()) : undefined);
  const base = { seq: change.seq, monitorId, kind: change.kind, at: change.at, ingestedAt: now, ...(url ? { url } : {}) };
  switch (change.kind) {
    case "entity_added":
      return name ? { ...base, name, detail: `Found ${name}` } : null;
    case "value_changed": {
      const before = valueOf(change.before);
      const after = valueOf(change.after);
      return name ? { ...base, name, detail: `${name}: ${before ? `${before} → ` : ""}${after ?? "changed"}` } : null;
    }
    case "fact_status_changed": {
      const after = valueOf(change.after);
      return name ? { ...base, name, detail: `${name} is now ${after ?? "re-judged"}` } : null;
    }
    case "alert": {
      const message = valueOf(change.after) ?? "Alert";
      return { ...base, name: name ?? "Alert", detail: message };
    }
    default:
      return null;
  }
}

/** object name → its first page, for the objects that are not rejected */
export function urlsByName(objects: readonly AgentObject[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const object of objects) {
    if (object.status === "rejected") continue;
    const url = object.urls?.find((u) => /^https?:\/\//.test(u));
    if (url && object.name) map.set(object.name.toLowerCase(), url);
  }
  return map;
}

export type IngestResult = { monitorId: string; findings: WatchFinding[]; sources: WatchSource[]; cursor: number };

export async function ingestMonitor(
  chatId: string,
  monitor: WatchMonitor,
  {
    client = sharedClient(),
    dir,
    vaultRoot,
    now = () => new Date().toISOString(),
  }: { client?: MonitorsClient; dir?: string; vaultRoot?: string; now?: () => string } = {},
): Promise<IngestResult> {
  let cursor = monitor.cursor ?? 0;
  const changes: Change[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await client.changes(monitor.id, { cursor });
    changes.push(...read.changes);
    const caught = read.changes.length === 0 || read.next_cursor === read.watermark;
    cursor = read.next_cursor ?? cursor;
    if (caught) break;
  }
  const stamp = now();
  const result: IngestResult = { monitorId: monitor.id, findings: [], sources: [], cursor };

  if (changes.some((c) => c.kind !== "run" && c.kind !== "plan_changed")) {
    let urls = new Map<string, string>();
    try {
      urls = urlsByName((await client.objects(monitor.id, { limit: 200 })).objects ?? []);
    } catch {
      /* findings without pages are still findings */
    }
    for (const change of changes) {
      const finding = findingOf(change, monitor.id, urls, stamp);
      if (finding) result.findings.push(finding);
    }
  }

  await updateChatWatch(
    chatId,
    (watch) => {
      const have = new Set(watch.findings.map((f) => `${f.monitorId}:${f.seq}`));
      const fresh = result.findings.filter((f) => !have.has(`${f.monitorId}:${f.seq}`));
      result.findings = fresh;
      watch.findings.push(...fresh);
      const urlsHad = new Set(watch.sources.map((s) => s.url));
      for (const finding of fresh) {
        if (!finding.url || urlsHad.has(finding.url)) continue;
        urlsHad.add(finding.url);
        const source = { title: finding.name, url: finding.url, monitorId: monitor.id, ingestedAt: stamp };
        watch.sources.push(source);
        result.sources.push(source);
      }
      watch.monitors = watch.monitors.map((m) => (m.id === monitor.id ? { ...m, cursor, lastIngestAt: stamp } : m));
    },
    dir,
  );

  if (result.findings.length) {
    const entries: WatchLogEntry[] = result.findings.map((f) => ({
      date: f.at.slice(0, 10),
      line: f.detail ?? f.name,
      url: f.url,
      title: f.name,
    }));
    try {
      await writeWatchFindings({ monitorId: monitor.id, topic: monitor.query, chatId, entries }, vaultRoot);
    } catch (error) {
      console.warn("[telem] could not write the watch notes:", error);
    }
  }
  return result;
}

/** one pass over every monitor every chat watches; a monitor that fails is skipped, not fatal */
export async function ingestAll(options: Parameters<typeof ingestMonitor>[2] & { dir?: string } = {}) {
  const results: IngestResult[] = [];
  for (const watch of await listChatWatches(options.dir)) {
    for (const monitor of watch.monitors) {
      if (monitor.deleted) continue;
      try {
        results.push(await ingestMonitor(watch.chatId, monitor, options));
      } catch (error) {
        console.warn(`[telem] reading monitor ${monitor.id} failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return results;
}
