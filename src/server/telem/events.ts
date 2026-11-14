/**
 * The in-process hook every Telem call reports to, so whatever watches usage
 * (src/server/telem/usage.ts) never has to wrap the client itself.
 *
 * The client (src/server/telem/client.ts) calls `emitTelemCall` once per
 * search or fetch, after it answers or fails; listeners subscribe with
 * `onTelemCall`. A listener that throws is logged and skipped — telemetry
 * never breaks a search.
 *
 * The listener set lives on `globalThis`: Next dev can load this module once
 * per route bundle, and the chat route's calls must reach a recorder the usage
 * route started.
 */

/** one provider's part in a call, as Telem's `preprocessor_runs` report it
 *  (for a fetch, one per URL, named by the provider that served it) */
export type TelemProviderRun = {
  provider: string;
  /** Telem's own word, e.g. "succeeded" or "failed" */
  status: string;
  latencyMs?: number;
  /** what Telem reported this run cost, when it does (exa's `costDollars`) */
  costUsd?: number;
  /** pages crawled, credits, tokens… whatever the provider bills by, when known */
  units?: number;
};

export type TelemCallMeta = {
  kind: "search" | "fetch";
  /** the providers that answered, in the order Telem ran them */
  providers: string[];
  /** every provider run, failures included, when the response had them */
  runs?: TelemProviderRun[];
  /** the whole call, wall clock */
  latencyMs: number;
  status: "ok" | "error";
  /** HTTP status or Telem's error code, on a failure */
  error?: string;
  /** Telem's `tier` (minimalist | default | extended | max) */
  tier?: string;
  /** the total Telem reported, when it does; otherwise usage.ts estimates it */
  costUsd?: number;
  /** what was asked: the query, or the URLs */
  query?: string;
  urls?: string[];
  /** Telem's lineage, echoed from the response */
  sessionId?: string;
  trajectoryId?: string;
  parentTrajectoryId?: string;
  interactionId?: string;
  /** ours */
  chatId?: string;
  /** the turn's index in the chat (its user message count) */
  turn?: number;
  /** "main", or the subagent's id */
  agent?: string;
  /** the chat tool call it served, so a row can show its providers */
  callId?: string;
  /** epoch ms; the emitter fills it in when missing */
  at?: number;
};

export type TelemCallListener = (meta: TelemCallMeta) => void;

const KEY = Symbol.for("agent_research.telem.listeners");
type Holder = { [KEY]?: Set<TelemCallListener> };

function listeners(): Set<TelemCallListener> {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= new Set());
}

/** subscribe; returns the unsubscribe */
export function onTelemCall(listener: TelemCallListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function emitTelemCall(meta: TelemCallMeta): void {
  const event = meta.at ? meta : { ...meta, at: Date.now() };
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch (error) {
      console.warn("[telem] usage listener failed:", error instanceof Error ? error.message : error);
    }
  }
}
