/**
 * A small client for Telem Monitors (https://docs.telem.ai/resources/monitors/).
 *
 * A monitor watches the web for one query on a schedule; its agent checks
 * every result against the query, keeps the ones that match as "objects", and
 * records a change stream (`/agent/changes`, read on from a cursor). Every
 * call here is one HTTP request to `https://router.telem.ai`, authorised with
 * `TELEM_API_KEY` (read per call, never logged).
 *
 * Errors: monitors answer `{"error": {"code", "message"}}`; other routes may
 * still answer `{"detail": "..."}`. Both become a `TelemError` with the HTTP
 * status and the code. A `429` is retried once after its `Retry-After` (at
 * most 10 s here, so a tool call never hangs on it).
 *
 * The response shapes below are the documented fields this app reads; Telem
 * may send more, which pass through untouched.
 */

export const TELEM_BASE = "https://router.telem.ai";

export type Frequency = "1h" | "6h" | "12h" | "1d" | "7d";
export const FREQUENCIES: readonly Frequency[] = ["1h", "6h", "12h", "1d", "7d"];
export const isFrequency = (value: unknown): value is Frequency =>
  typeof value === "string" && (FREQUENCIES as readonly string[]).includes(value);

/** the cheapest schedule that still feels "watched": a run costs $0.003–0.015 (pricing page) */
export const DEFAULT_FREQUENCY: Frequency = "1d";
/** how long a watch lives: a monitor with an agent bills every run until it ends */
export const DEFAULT_TTL = "7d";

export type AgentState = {
  status?: string;
  needs_attention?: boolean;
  plan_version?: number;
  next_run_at?: string | null;
  watermark?: number;
  compile?: { status?: string; error?: string | null } | null;
};

export type Monitor = {
  id: string;
  query: string;
  frequency: string;
  status: "active" | "paused" | "ended" | string;
  session_id?: string;
  created_at?: string;
  last_polled_at?: string | null;
  expires_at?: string | null;
  agent_note?: string | null;
  agent_state?: AgentState | null;
};

export type Tick = {
  tick?: number;
  started_at?: string;
  finished_at?: string;
  at?: string;
  usd?: number;
  stop_reason?: string;
  [key: string]: unknown;
};

export type Agent = {
  monitor_id: string;
  status: string;
  query: string;
  frequency: string;
  spec_version?: number;
  spec?: Record<string, unknown> | null;
  counts?: Record<string, unknown>;
  ticks?: Tick[];
  next_tick_at?: string | null;
  spend_usd?: number;
  budget?: Record<string, unknown> | null;
  source_health?: Record<string, unknown>[];
  compile?: { job_id?: string; status?: string; error?: string | null } | null;
  running_job?: { id?: string; job_id?: string; kind?: string; status?: string } | null;
  suggested_prompts?: string[];
};

export type ChangeKind = "entity_added" | "value_changed" | "fact_status_changed" | "alert" | "run" | "plan_changed";

export type Change = {
  seq: number;
  type?: string;
  kind: ChangeKind | string;
  monitor_id?: string;
  subject?: { entity_id?: string | null; name?: string | null } | null;
  before?: unknown;
  after?: unknown;
  fact_ids?: string[];
  at: string;
};

export type ChangesPage = { changes: Change[]; next_cursor: number; watermark: number };

export type AgentEvent = {
  tick: number;
  kind: string;
  identity_key?: string | null;
  payload?: Record<string, unknown>;
  at?: string;
};

export type AgentObject = {
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
  fetched_ever?: boolean;
  urls?: string[];
  sources?: number;
  history?: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
};

export type Panel = {
  id: string;
  title: string;
  kind?: string;
  recipe?: Record<string, unknown>;
  prompt?: string | null;
  order?: number;
  status?: string;
  error?: string | null;
  version?: Record<string, unknown> | null;
};

export type ChatMessage = { role: string; text: string; panel_ids?: string[]; at?: string; created_at?: string };

export type Job = {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed" | string;
  waiting_for?: string | null;
  steps?: Record<string, unknown>[];
  result?: Record<string, unknown> | null;
  error?: string | null;
  error_code?: string | null;
  usd?: number;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
};

export class TelemError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TelemError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MonitorsClientOptions = {
  apiKey?: string;
  fetch?: FetchLike;
  base?: string;
  /** the longest a 429 is waited out before the one retry, in ms */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** the key, when there is one: Telem is optional, and everything here is off without it */
export function telemKey(): string | undefined {
  const key = process.env.TELEM_API_KEY?.trim();
  return key ? key : undefined;
}

export const telemConfigured = () => telemKey() !== undefined;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMonitorsClient(options: MonitorsClientOptions = {}) {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.base ?? TELEM_BASE;
  const maxWait = options.maxRetryWaitMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;

  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    const key = options.apiKey ?? telemKey();
    if (!key) throw new TelemError("Telem is not configured (no TELEM_API_KEY)", 0, "not_configured");
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
    }
    const url = `${base}${path}${params.size ? `?${params}` : ""}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (response.status === 429 && attempt === 0) {
        const after = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 2000;
        if (wait <= maxWait) {
          await sleep(wait);
          continue;
        }
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        /* not JSON: the status says enough */
      }
      if (!response.ok) {
        const shape = json as { error?: { code?: string; message?: string }; detail?: unknown } | undefined;
        const detail =
          shape?.error?.message ??
          (typeof shape?.detail === "string" ? shape.detail : shape?.detail ? JSON.stringify(shape.detail) : undefined);
        throw new TelemError(
          `Telem ${method} ${path} failed (${response.status}${shape?.error?.code ? ` ${shape.error.code}` : ""})${detail ? `: ${detail}` : ""}`,
          response.status,
          shape?.error?.code,
        );
      }
      return json as T;
    }
  }

  const m = (id: string) => `/v1/monitors/${encodeURIComponent(id)}`;

  return {
    /** POST /v1/monitors — with an agent (the default), a schedule and an end */
    create(input: { query: string; frequency?: Frequency; ttl?: string; includeDomains?: string[]; metadata?: Record<string, unknown> }) {
      return call<Monitor>("POST", "/v1/monitors", {
        query: input.query,
        options: {
          frequency: input.frequency ?? DEFAULT_FREQUENCY,
          ...(input.includeDomains?.length ? { include_domains: input.includeDomains } : {}),
        },
        ttl: input.ttl ?? DEFAULT_TTL,
        agent: true,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
    },
    list(input: { limit?: number; cursor?: string } = {}) {
      return call<{ monitors: Monitor[]; next_cursor: string | null }>("GET", "/v1/monitors", undefined, {
        limit: input.limit ?? 50,
        cursor: input.cursor,
      });
    },
    get: (id: string) => call<Monitor>("GET", m(id)),
    /** PATCH /v1/monitors/{id}: pause/resume, a new frequency, or a new end */
    update: (id: string, change: { status?: "active" | "paused"; frequency?: Frequency; ttl?: string }) =>
      call<Monitor>("PATCH", m(id), change),
    delete: (id: string) => call<void>("DELETE", m(id)),
    /** the legacy poll of the monitor's own results; the agent's changes are the way now */
    poll: (id: string) => call<Record<string, unknown>>("POST", `${m(id)}/poll`),

    agent: (id: string) => call<Agent>("GET", `${m(id)}/agent`),
    updateAgent: (id: string, change: { status?: "paused" | "active"; budget?: Record<string, unknown> }) =>
      call<Agent>("PATCH", `${m(id)}/agent`, change),
    /** a tick now, outside the schedule (a paused agent runs too) */
    runNow: (id: string) => call<{ job_id: string }>("POST", `${m(id)}/agent/ticks`),
    jobs: (id: string, input: { kind?: "compile" | "tick" | "chat" | "shadow_delete"; limit?: number } = {}) =>
      call<{ jobs: Job[] }>("GET", `${m(id)}/agent/jobs`, undefined, input),
    job: (id: string, jobId: string) => call<Job>("GET", `${m(id)}/agent/jobs/${encodeURIComponent(jobId)}`),
    changes: (id: string, input: { cursor?: number; kinds?: string; limit?: number } = {}) =>
      call<ChangesPage>("GET", `${m(id)}/agent/changes`, undefined, { cursor: input.cursor ?? 0, kinds: input.kinds, limit: input.limit }),
    events: (id: string, input: { limit?: number; kind?: string; since_tick?: number } = {}) =>
      call<{ events: AgentEvent[] }>("GET", `${m(id)}/agent/events`, undefined, input),
    objects: (id: string, input: { status?: string; q?: string; limit?: number; offset?: number } = {}) =>
      call<{ total: number; objects: AgentObject[] }>("GET", `${m(id)}/agent/objects`, undefined, input),
    object: (id: string, identityKey: string) =>
      call<AgentObject>("GET", `${m(id)}/agent/objects/${encodeURIComponent(identityKey)}`),
    panels: (id: string) => call<{ panels: Panel[] }>("GET", `${m(id)}/agent/panels`),
    updatePanel: (id: string, panelId: string, change: { title?: string; order?: number }) =>
      call<Panel>("PATCH", `${m(id)}/agent/panels/${encodeURIComponent(panelId)}`, change),
    deletePanel: (id: string, panelId: string) =>
      call<void>("DELETE", `${m(id)}/agent/panels/${encodeURIComponent(panelId)}`),
    /** ask the monitor's agent something; it answers in a job (read it with `chatMessages`) */
    chat: (id: string, message: string, panelId?: string) =>
      call<{ job_id: string; message_id: string }>("POST", `${m(id)}/agent/chat`, {
        message: message.slice(0, 4000),
        ...(panelId ? { panel_id: panelId } : {}),
      }),
    chatMessages: (id: string, limit = 50) =>
      call<{ messages: ChatMessage[] }>("GET", `${m(id)}/agent/chat`, undefined, { limit }),
    deleteStep: (id: string, name: string) => call<void>("DELETE", `${m(id)}/agent/steps/${encodeURIComponent(name)}`),
  };
}

export type MonitorsClient = ReturnType<typeof createMonitorsClient>;

let shared: MonitorsClient | null = null;
/** the app's one client (it reads the key per call, so it is safe to keep) */
export function monitors(): MonitorsClient {
  shared ??= createMonitorsClient();
  return shared;
}

/** a job's terminal states */
export const jobDone = (job: Pick<Job, "status">) => job.status === "done" || job.status === "failed";

/**
 * Wait for a job to finish, polling every `everyMs`, up to `timeoutMs`.
 * Returns the last state seen (which may still be running on a timeout).
 */
export async function waitForJob(
  client: MonitorsClient,
  id: string,
  jobId: string,
  { timeoutMs = 90_000, everyMs = 2500, sleep = defaultSleep, signal }: { timeoutMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<Job> {
  const started = Date.now();
  for (;;) {
    const job = await client.job(id, jobId);
    if (jobDone(job) || Date.now() - started >= timeoutMs || signal?.aborted) return job;
    await sleep(everyMs);
  }
}

/** the agent's reply to a chat job: from its result, else the newest agent message */
export function chatReply(job: Job | undefined, messages: readonly ChatMessage[] = []): string | undefined {
  const result = job?.result as { reply?: unknown; text?: unknown; message?: unknown } | null | undefined;
  for (const value of [result?.reply, result?.text, result?.message]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" && typeof message.text === "string" && message.text.trim()) return message.text.trim();
  }
  return undefined;
}
