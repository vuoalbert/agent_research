import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

import { isActive, type JobDetail, type JobRecord, type JobSummary } from "@/lib/visualize";

import { createAgentRunner, type RunAgent } from "./agent";
import { isJobId, jobPaths, newJobId, studioPaths, type StudioPaths } from "./paths";
import { createJobStore } from "./store";

/**
 * The Visualize runner. There is only ever ONE visualization — the current
 * one — so a burst of research turns can never pile up hours of plan usage:
 *
 * - `startJob` without `explicit` (after research, Claude's own call or the
 *   chat's fallback): while the current visualization is still building it
 *   does nothing and answers `busy`; otherwise the new one replaces it.
 * - `startJob` with `explicit` (the user asked for this figure): a running
 *   one is stopped and discarded, and the new one starts at once.
 * - Replacing a visualization deletes its job folder, so the disk never holds
 *   more than the current one (and nothing stale on a restart).
 * - Each job gets 60 minutes. At the limit it is aborted; if the agent had
 *   already written `figure.html` by then, that page is kept and the job
 *   counts as done, otherwise it failed. `stopJob` stops it early.
 * - Jobs persist on disk (store.ts). When the runner starts in a new server
 *   process, a job an earlier process left running is marked `interrupted`:
 *   nothing runs it any more, and starting a long, plan-billed run again on
 *   its own after a restart would surprise.
 * - When a job ends, the runner copies `work/figure.html` beside the work
 *   folder; that copy is what the figure route serves, so the agent can never
 *   change a finished page.
 *
 * One runner per server process (`getRunner`), kept on `globalThis` so the
 * dev server's module reloads do not start a second one or re-run recovery.
 */

export const TIMEOUT_MS = 60 * 60 * 1000;
/** how long a Stop waits for the agent to wind down before settling the job anyway */
const STOP_GRACE_MS = 15_000;
const LOG_TAIL = 50;
/** the most the figure route will serve */
export const MAX_FIGURE_BYTES = 15 * 1024 * 1024;

export class StudioNotReadyError extends Error {
  constructor() {
    super("Visualize isn't set up on this machine: run `npm run setup:visualize` first.");
  }
}

export type StartInput = {
  subject: string;
  brief?: string;
  origin?: JobRecord["origin"];
  /** the user asked for this one: replace whatever is there, running or not */
  explicit?: boolean;
};

/** a new visualization (and the one it replaced), or the one still building */
export type StartResult =
  | { status: "started"; job: JobRecord; replaced?: string }
  | { status: "busy"; job: JobRecord };

export type RunnerOptions = {
  paths?: StudioPaths;
  runAgent?: RunAgent;
  timeoutMs?: number;
  now?: () => number;
  pid?: number;
};

type Slot = {
  id: string;
  abort: AbortController;
  reason?: "stop" | "timeout" | "discard";
  settled: Promise<void>;
};

export function createRunner({
  paths = studioPaths(),
  runAgent = createAgentRunner(),
  timeoutMs = TIMEOUT_MS,
  now = Date.now,
  pid = process.pid,
}: RunnerOptions = {}) {
  const store = createJobStore(paths, now);
  let current: Slot | null = null;
  let idle: Promise<void> = Promise.resolve();

  /** delete a job's folder: it has been replaced */
  function discard(id: string) {
    if (!isJobId(id)) return;
    rmSync(jobPaths(paths, id).dir, { recursive: true, force: true });
  }

  /** every job folder but `keep`'s goes */
  function discardAllBut(keep: string | null) {
    if (!existsSync(paths.jobs)) return;
    for (const entry of readdirSync(paths.jobs)) {
      if (entry !== keep && isJobId(entry)) discard(entry);
    }
  }

  /** the one visualization there is (the newest, should two ever exist) */
  function latest(): JobRecord | null {
    return store.list()[0] ?? null;
  }

  /** copy the agent's page beside its work folder, if it wrote one */
  function keepFigure(id: string): "figure.html" | undefined {
    const job = jobPaths(paths, id);
    try {
      if (!existsSync(job.workFigure)) return undefined;
      const stats = statSync(job.workFigure);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FIGURE_BYTES) return undefined;
      copyFileSync(job.workFigure, job.figure);
      return "figure.html";
    } catch {
      return undefined;
    }
  }

  /* starting up: keep only the newest job, and if an earlier process was
     running it, it is no longer running */
  {
    const newest = latest();
    discardAllBut(newest?.id ?? null);
    if (newest && isActive(newest.status) && newest.pid !== pid) {
      const figure = keepFigure(newest.id);
      store.write({
        ...newest,
        status: "interrupted",
        endedAt: newest.endedAt ?? now(),
        error:
          newest.status === "running"
            ? "The server restarted while this figure was being built."
            : "The server restarted before this figure started.",
        ...(figure ? { figure } : {}),
      });
      store.appendLog(newest.id, "Interrupted: the server restarted");
    }
  }

  function ready() {
    return existsSync(`${paths.skill}/SKILL.md`) && existsSync(paths.plugin) && existsSync(paths.chrome);
  }

  function startJob({ subject, brief, origin, explicit = false }: StartInput): StartResult {
    const cleanSubject = subject.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!cleanSubject) throw new Error("A visualization needs a subject.");
    if (!ready()) throw new StudioNotReadyError();
    const cleanBrief = brief?.trim().slice(0, 2000) || undefined;

    const existing = latest();
    if (existing && isActive(existing.status) && !explicit) return { status: "busy", job: existing };

    // explicit: the one building is stopped and thrown away, not finished
    if (current) {
      current.reason = "discard";
      current.abort.abort();
      current = null;
    }

    let id = newJobId(cleanSubject, new Date(now()));
    while (store.read(id)) id = newJobId(cleanSubject, new Date(now()));
    mkdirSync(jobPaths(paths, id).work, { recursive: true });
    const record = store.write({
      id,
      subject: cleanSubject,
      ...(cleanBrief ? { brief: cleanBrief } : {}),
      ...(origin ? { origin } : {}),
      status: "running",
      createdAt: now(),
      startedAt: now(),
      pid,
    });
    discardAllBut(id);
    store.appendLog(
      id,
      `Started the background agent (Claude Opus 5.5, anatomy skill)${existing ? `, replacing "${existing.subject}"` : ""}`,
    );
    run(record);
    return { status: "started", job: record, ...(existing ? { replaced: existing.id } : {}) };
  }

  function run(record: JobRecord) {
    const { id } = record;
    const abort = new AbortController();
    const slot: Slot = { id, abort, settled: Promise.resolve() };
    current = slot;

    const timer = setTimeout(() => {
      slot.reason = "timeout";
      store.appendLog(id, "Reached the 60-minute limit; stopping the agent");
      abort.abort();
    }, timeoutMs);

    slot.settled = (async () => {
      let result: Awaited<ReturnType<RunAgent>>;
      try {
        result = await runAgent({
          job: record,
          studio: paths,
          paths: jobPaths(paths, id),
          signal: abort.signal,
          log: (line) => store.appendLog(id, line),
        });
      } catch (error) {
        result = { outcome: "error", detail: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
      // a discarded job's folder is gone: there is nothing to settle
      if (slot.reason !== "discard") finish(id, result, slot.reason);
      if (current === slot) current = null;
    })();
    idle = slot.settled;
  }

  function finish(id: string, result: Awaited<ReturnType<RunAgent>>, reason?: Slot["reason"]) {
    const record = store.read(id);
    if (!record || record.status !== "running") return;
    const figure = keepFigure(id);
    const turns = "turns" in result ? result.turns : undefined;
    const base = { ...record, endedAt: now(), ...(figure ? { figure } : {}), ...(turns ? { turns } : {}) };

    let next: JobRecord;
    if (reason === "stop") {
      next = { ...base, status: "stopped", error: "Stopped before it finished." };
    } else if (reason === "timeout") {
      next = figure
        ? { ...base, status: "done", note: "Stopped at the 60-minute limit; this is the last page it wrote." }
        : { ...base, status: "error", error: "Ran out of time: 60 minutes without a finished figure." };
    } else if (result.outcome === "success") {
      next = figure
        ? { ...base, status: "done" }
        : { ...base, status: "error", error: "The agent finished without writing figure.html." };
    } else if (result.outcome === "error") {
      next = { ...base, status: "error", error: result.detail };
    } else {
      next = { ...base, status: "stopped", error: "Stopped before it finished." };
    }
    store.write(next);
    store.appendLog(
      id,
      next.status === "done"
        ? `Figure ready${next.note ? ` (${next.note})` : ""}`
        : `${next.status === "stopped" ? "Stopped" : "Failed"}: ${next.error ?? ""}`,
    );
  }

  /** stop the running job; resolves once it has settled (or the grace period ran out) */
  async function stopJob(id: string): Promise<JobRecord | null> {
    const record = store.read(id);
    if (!record) return null;
    if (current?.id !== id) return record;
    const slot = current;
    slot.reason = "stop";
    store.appendLog(id, "Stop requested");
    slot.abort.abort();
    const grace = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), STOP_GRACE_MS));
    if ((await Promise.race([slot.settled.then(() => "settled" as const), grace])) === "late") {
      // the agent did not wind down in time: settle the job anyway
      finish(id, { outcome: "aborted" }, "stop");
      if (current === slot) current = null;
    }
    return store.read(id);
  }

  function summary(record: JobRecord): JobSummary {
    const elapsedMs = record.startedAt ? (record.endedAt ?? now()) - record.startedAt : 0;
    const [last] = store.tailLog(record.id, 1);
    return { ...record, elapsedMs, ...(last ? { lastLine: last.text } : {}) };
  }

  function getJob(id: string, lines = LOG_TAIL): JobDetail | null {
    const record = store.read(id);
    return record ? { ...summary(record), log: store.tailLog(id, lines) } : null;
  }

  /** the current visualization in full, or null when there is none */
  function currentJob(lines = LOG_TAIL): JobDetail | null {
    const record = latest();
    return record ? getJob(record.id, lines) : null;
  }

  /** the served copy of a finished job's page, or null */
  function figureFile(id: string): string | null {
    if (!isJobId(id)) return null;
    const record = store.read(id);
    if (!record?.figure) return null;
    const { figure } = jobPaths(paths, id);
    return existsSync(figure) ? figure : null;
  }

  return {
    startJob,
    stopJob,
    getJob,
    currentJob,
    figureFile,
    ready,
    /** resolves when the job in progress (if any) has settled; for tests */
    whenSettled: () => idle,
  };
}

export type Runner = ReturnType<typeof createRunner>;

const KEY = Symbol.for("agent_research.visualize.runner");
type Holder = { [KEY]?: Runner };

/** the server's one runner */
export function getRunner(): Runner {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= createRunner());
}
