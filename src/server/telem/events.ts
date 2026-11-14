/**
 * Telem call events — the in-process contract between the Telem client
 * (`./client.ts`) and anything that wants to record what Telem did (the
 * Observe / usage view).
 *
 * Every `telemSearch` / `telemFetch` emits exactly ONE `TelemCallMeta` when it
 * settles — success, partial success, failure, or a Tavily fallback — after the
 * result is in hand and before it is returned to the caller. Listeners run
 * synchronously in registration order; a listener that throws is logged and
 * skipped, never surfaced to the caller. Nothing is buffered: a listener only
 * sees calls made after it registered.
 *
 *   import { onTelemCall } from "@/server/telem/events";
 *   const off = onTelemCall((meta) => usage.record(meta));
 *   // … later
 *   off();
 *
 * The shape is append-only: fields may be added, never renamed or removed.
 * No API keys, page bodies or result lists travel on it — counts and ids only
 * (plus the query / URLs the call was for).
 */

export type TelemCallKind = "search" | "fetch";

/** who inside the app made the call */
export type TelemCaller = "chat" | "subagent" | "crossref" | (string & {});

/** one provider's part in a call: a search provider's run, or the fetch provider that answered one URL */
export type TelemProviderRun = {
  provider: string;
  /** Telem's own status for this run ("succeeded", "failed", …) */
  status: string;
  latencyMs: number | null;
  /** search: rows this provider returned; fetch: 1 if it returned the page, else 0 */
  results: number;
  error?: string;
  /** provider-native usage, verbatim, when Telem passes it through */
  usage?: unknown;
};

export type TelemCallMeta = {
  /** unique per call, generated client-side */
  id: string;
  kind: TelemCallKind;
  caller: TelemCaller;
  /** the app chat this call belongs to (absent for calls outside a chat) */
  chatId?: string;
  /** the chat turn (one POST /api/chat) */
  turnId?: string;
  /** a subagent's id, when a subagent made the call */
  agentId?: string;
  agentTitle?: string;
  /** search: the query */
  query?: string;
  /** fetch: the URLs asked for */
  urls?: string[];
  /** the provider list the call pinned (search include list / fetch chain), if any */
  pinnedProviders?: string[];
  /** a platform hint that chose the pinned providers (x, youtube, maps, …) */
  platform?: string;
  tier?: string;
  autoRouting?: "accuracy" | "off";

  /** Telem's ids — the same ones its Observe console shows */
  sessionId?: string;
  interactionId?: string;
  trajectoryId?: string;
  parentTrajectoryId?: string | null;

  /** "succeeded" | "partially_succeeded" | "failed" from Telem; "error" when the call threw */
  status: "succeeded" | "partially_succeeded" | "failed" | "error" | (string & {});
  /** search providers that ran / fetch providers that answered */
  providers: TelemProviderRun[];
  /** auto-routing's decision, verbatim: `[{ topic, score, providers }]` */
  routing?: unknown;
  /** search: merged, de-duplicated results returned to the caller; fetch: pages read */
  resultCount: number;
  /** fetch: URLs that could not be read */
  failedCount?: number;
  /** wall-clock time of the whole call, including any fallback */
  latencyMs: number;
  startedAt: number;
  finishedAt: number;
  /** Telem does not return a charge on the call (the console has it); set only if it ever does */
  costUsd?: number;
  /** set when Telem failed and the call was served by the Tavily fallback */
  fallback?: "tavily";
  /** why Telem failed (the fallback's reason, or the call's error) */
  error?: string;
};

export type TelemCallListener = (meta: TelemCallMeta) => void;

const listeners = new Set<TelemCallListener>();

/** listen to every Telem call; returns the unsubscribe */
export function onTelemCall(listener: TelemCallListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** called by the client once per settled call */
export function emitTelemCall(meta: TelemCallMeta): void {
  for (const listener of [...listeners]) {
    try {
      listener(meta);
    } catch (error) {
      console.warn("[telem] onTelemCall listener failed:", error);
    }
  }
}

/** test-only */
export function __clearTelemListeners() {
  listeners.clear();
}
