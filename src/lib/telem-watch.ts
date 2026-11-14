/**
 * The Telem tab's and the Knowledge base's view of Telem Monitors: the shapes
 * the /api/telem/monitors routes answer with, and their endpoints. A plain
 * module (no "use client"), so tests and the server can share it.
 */

export const MONITORS_ENDPOINT = "/api/telem/monitors";
export const monitorEndpoint = (id: string) => `${MONITORS_ENDPOINT}/${encodeURIComponent(id)}`;
export const runEndpoint = (id: string) => `${monitorEndpoint(id)}/run`;
export const monitorChatEndpoint = (id: string) => `${monitorEndpoint(id)}/chat`;
export const objectEndpoint = (id: string, key: string) => `${monitorEndpoint(id)}/objects/${encodeURIComponent(key)}`;
export const panelEndpoint = (id: string, panelId: string) => `${monitorEndpoint(id)}/panels/${encodeURIComponent(panelId)}`;
export const updatesEndpoint = (chatId: string) => `${MONITORS_ENDPOINT}/updates?chat=${encodeURIComponent(chatId)}`;

export const FREQUENCY_LABEL: Record<string, string> = {
  "1h": "Hourly",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  "1d": "Daily",
  "7d": "Weekly",
};
export const FREQUENCY_OPTIONS = ["1h", "6h", "12h", "1d", "7d"] as const;

export type MonitorRow = {
  id: string;
  query: string;
  frequency: string;
  status: string;
  created_at?: string;
  expires_at?: string | null;
  agent_state?: { status?: string; next_run_at?: string | null; watermark?: number } | null;
  chat: { chatId: string; auto: boolean; lastIngestAt?: string } | null;
  agent: {
    status: string;
    spend_usd: number | null;
    budget: Record<string, unknown> | null;
    next_tick_at: string | null;
    last_tick: Record<string, unknown> | null;
    counts: Record<string, unknown> | null;
  } | null;
};

export type MonitorChange = {
  seq: number;
  kind: string;
  subject?: { entity_id?: string | null; name?: string | null } | null;
  before?: unknown;
  after?: unknown;
  at: string;
};

export type MonitorEvent = { tick: number; kind: string; identity_key?: string | null; payload?: Record<string, unknown>; at?: string };

export type MonitorObject = {
  identity_key: string;
  name: string;
  kind?: string;
  status: string;
  first_seen_tick?: number;
  last_seen_tick?: number | null;
  qualified_since_tick?: number | null;
  observed?: boolean;
  attributes?: Record<string, unknown>;
  criteria?: Record<string, unknown>;
  discovered_via?: string | null;
  urls?: string[];
  sources?: number;
  history?: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
};

export type MonitorPanel = {
  id: string;
  title: string;
  kind?: string;
  prompt?: string | null;
  status?: string;
  error?: string | null;
  version?: Record<string, unknown> | null;
};

export type MonitorChatMessage = { role: string; text: string; panel_ids?: string[] };

export type MonitorJob = { id: string; kind: string; status: string; error?: string | null; usd?: number; created_at?: string | null; finished_at?: string | null };

export type MonitorDetail = {
  monitor: MonitorRow & { last_polled_at?: string | null; session_id?: string };
  agent: {
    status: string;
    spec_version?: number;
    spec?: Record<string, unknown> | null;
    counts?: Record<string, unknown>;
    ticks?: Record<string, unknown>[];
    next_tick_at?: string | null;
    spend_usd?: number;
    budget?: Record<string, unknown> | null;
    source_health?: Record<string, unknown>[];
    running_job?: Record<string, unknown> | null;
    suggested_prompts?: string[];
  } | null;
  changes: MonitorChange[];
  events: MonitorEvent[];
  objects: MonitorObject[];
  objectsTotal: number;
  panels: MonitorPanel[];
  chat: MonitorChatMessage[];
  jobs: MonitorJob[];
};

export type WatchUpdates = {
  configured: boolean;
  monitors: { id: string; query: string; frequency: string; auto: boolean; deleted: boolean; lastIngestAt: string | null }[];
  sources: { title: string; url: string; monitorId: string }[];
  findings: { seq: number; monitorId: string; kind: string; name: string; detail?: string; url?: string; at: string }[];
  fresh: { sources: string[]; findings: boolean };
};

/** "$0.012" — spend is small, so three places under a dollar */
export function formatUsd(usd: unknown): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** "in 3 h", "5 min ago", or the date */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const diff = at - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? null : abs < 3_600_000 ? [60_000, "min"] : abs < 86_400_000 ? [3_600_000, "h"] : [86_400_000, "d"];
  if (!unit) return diff > 0 ? "in a moment" : "just now";
  const n = Math.round(abs / (unit[0] as number));
  return diff > 0 ? `in ${n} ${unit[1]}` : `${n} ${unit[1]} ago`;
}

/** the time a tick ran, whichever field Telem used */
export function tickTime(tick: Record<string, unknown> | null | undefined): string | null {
  if (!tick) return null;
  for (const key of ["finished_at", "ended_at", "at", "started_at", "created_at"]) {
    if (typeof tick[key] === "string") return tick[key] as string;
  }
  return null;
}

/** a monitor's budget per day, when it has one */
export function budgetPerDay(budget: Record<string, unknown> | null | undefined): number | null {
  if (!budget) return null;
  for (const [key, value] of Object.entries(budget)) {
    if (/day|daily/i.test(key) && typeof value === "number") return value;
  }
  return null;
}

/** a status or kind word for people: `age_unclear` → `age unclear` */
export const words = (value: string) => value.replace(/_/g, " ");

/** any JSON-ish value as one short line */
export function brief(value: unknown, max = 160): string {
  if (value === null || value === undefined) return "";
  let text: string;
  /* a bare code word (`budget_estimate`) reads as words */
  if (typeof value === "string") text = /^[a-z]+(_[a-z]+)+$/.test(value) ? words(value) : value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value)) text = value.map((v) => brief(v, max)).filter(Boolean).join(", ");
  else {
    const v = value as Record<string, unknown>;
    const pick = v.value ?? v.status ?? v.verdict ?? v.text ?? v.message ?? v.summary ?? v.error ?? v.reason;
    text =
      pick !== undefined && pick !== null
        ? brief(pick, max)
        : Object.entries(v)
            /* the readable fields only: no ids, no nested objects */
            .filter(([k, x]) => x !== null && x !== undefined && typeof x !== "object" && !/(^|_)id$/.test(k))
            .map(([k, x]) => `${k.replace(/_/g, " ")} ${String(x).replace(/_/g, " ")}`)
            .join(", ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
