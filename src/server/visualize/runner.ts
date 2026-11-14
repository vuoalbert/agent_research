import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

import { deleteSession } from "@anthropic-ai/claude-agent-sdk";

import { MESSAGE_LINE_PREFIX, isActive, type JobDetail, type JobRecord, type JobSummary } from "@/lib/visualize";

import { createAgentRunner, type RunAgent } from "./agent";
import { createInbox, type Inbox } from "./inbox";
import { liveMessage, replyFrom, resumeMessage } from "./messages";
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
 * - `sendMessage` (the chat's message_visualize) talks to the agent behind
 *   the current visualization. While it is building, the message goes into
 *   the live session (inbox.ts) and the agent reads it between tool calls.
 *   Once it has ended — done, stopped, failed or interrupted — the message
 *   resumes its saved session (`sessionId`) in the same job: status running
 *   again, a fresh 60 minutes, the agent edits its build and re-copies the
 *   page, which is copied again when it ends. Still one visualization at a
 *   time: a resumed one is "building" to `startJob` like any other. A message
 *   that misses a closing run (or that no turn took before it ended) resumes
 *   the session once that run has settled, unless the user stopped it.
 *   The agent's reply to a run that carried a message is the job's
 *   `lastReply`.
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

/** what became of a message for the Visualize agent */
export type MessageResult =
  | { status: "none" }
  /** delivered into the run in progress (or to the resume that follows it) */
  | { status: "live"; job: JobRecord }
  /** the visualization had ended: its session resumed with the message */
  | { status: "resumed"; job: JobRecord }
  | { status: "unavailable"; job: JobRecord; reason: string };

/** a message is one request, not a document */
export const MAX_MESSAGE = 2000;

export type RunnerOptions = {
  paths?: StudioPaths;
  runAgent?: RunAgent;
  timeoutMs?: number;
  now?: () => number;
  pid?: number;
  /** drop a discarded job's agent session from disk (best effort) */
  forgetSession?: (sessionId: string) => void;
};

type Slot = {
  id: string;
  abort: AbortController;
  reason?: "stop" | "timeout" | "discard";
  settled: Promise<void>;
  /** the run's input: the chat's messages go in here while it is open */
  inbox: Inbox;
  /** the chat's messages pushed into this run, to tell the ones no turn took */
  sent: { uuid: string; text: string }[];
  /** messages that came after the inbox closed: they resume the session once this run has settled */
  carry: string[];
  /** this run carried a message, so its last reply answers it */
  answered: boolean;
  sessionId?: string;
  /** the job has been settled for this run (a Stop that ran out of grace does it early) */
  finished?: boolean;
};

const defaultForget = (sessionId: string) => {
  deleteSession(sessionId).catch(() => {
    /* already gone, or never written */
  });
};

export function createRunner({
  paths = studioPaths(),
  runAgent = createAgentRunner(),
  timeoutMs = TIMEOUT_MS,
  now = Date.now,
  pid = process.pid,
  forgetSession = defaultForget,
}: RunnerOptions = {}) {
  const store = createJobStore(paths, now);
  let current: Slot | null = null;
  let idle: Promise<void> = Promise.resolve();

  /** delete a job's folder, and its agent's session: it has been replaced */
  function discard(id: string) {
    if (!isJobId(id)) return;
    // a run still winding down forgets its session once it has settled
    const sessionId = current?.id === id ? undefined : store.read(id)?.sessionId;
    rmSync(jobPaths(paths, id).dir, { recursive: true, force: true });
    if (sessionId) forgetSession(sessionId);
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

  /** run the agent: the build, or (`resumeWith`) its saved session with the chat's messages */
  function run(record: JobRecord, resumeWith?: { sessionId: string; messages: string[] }) {
    const { id } = record;
    const abort = new AbortController();
    const slot: Slot = {
      id,
      abort,
      settled: Promise.resolve(),
      inbox: createInbox(),
      sent: [],
      carry: [],
      answered: resumeWith !== undefined,
      ...(resumeWith ? { sessionId: resumeWith.sessionId } : {}),
    };
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
          inbox: slot.inbox,
          ...(resumeWith ? { resume: resumeWith.sessionId, prompt: resumeMessage(resumeWith.messages) } : {}),
          onSession: (sessionId) => {
            slot.sessionId = sessionId;
            // saved at once, so even a run cut short by a restart can be resumed
            if (slot.reason !== "discard") store.update(id, { sessionId });
          },
        });
      } catch (error) {
        result = { outcome: "error", detail: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
        slot.inbox.close();
      }
      if (current === slot) current = null;
      // a discarded job's folder is gone: there is nothing to settle
      if (slot.reason === "discard") {
        if (slot.sessionId) forgetSession(slot.sessionId);
        return;
      }
      // settled early by a Stop: the job may be running a resume by now
      if (slot.finished) return;
      finish(id, result, slot);
      // the messages this run missed resume it now (unless the user stopped it)
      const missed = slot.reason === "stop" ? [] : slot.sent.filter((m) => slot.inbox.isPending(m.uuid)).map((m) => m.text);
      const late = [...missed, ...slot.carry];
      if (late.length && !current) {
        const record = store.read(id);
        if (record?.sessionId) resume(record, late);
        else store.appendLog(id, "Couldn't pass on the chat's message: the agent's session wasn't saved");
      } else if (slot.reason === "stop" && slot.sent.some((m) => slot.inbox.isPending(m.uuid))) {
        store.appendLog(id, "The chat's last message wasn't applied: the agent was stopped first");
      }
    })();
    idle = slot.settled;
  }

  /** the job's session again, with these messages as its next turn */
  function resume(record: JobRecord, messages: string[]): JobRecord {
    const { endedAt: _ended, error: _error, note: _note, ...rest } = record;
    const next = store.write({ ...rest, status: "running", startedAt: now(), pid });
    store.appendLog(record.id, "Resumed the background agent's session to apply it");
    run(next, { sessionId: record.sessionId!, messages });
    return next;
  }

  /**
   * A message from the chat for the agent behind the current visualization:
   * into the live run, or a resume of the finished one (see the top).
   */
  function sendMessage(message: string): MessageResult {
    const text = message.trim().slice(0, MAX_MESSAGE);
    if (!text) throw new Error("A message needs some text.");
    const record = latest();
    if (!record) return { status: "none" };
    const { id } = record;

    if (current?.id === id) {
      const slot = current;
      store.appendLog(id, `${MESSAGE_LINE_PREFIX}${text}`);
      const counted = store.update(id, { messages: (record.messages ?? 0) + 1 }) ?? record;
      // a run already stopping or timing out takes nothing more: it resumes with it
      const uuid = slot.reason ? null : slot.inbox.push(liveMessage(text));
      if (uuid) {
        slot.sent.push({ uuid, text });
        slot.answered = true;
      } else slot.carry.push(text);
      return { status: "live", job: counted };
    }
    if (isActive(record.status))
      return { status: "unavailable", job: record, reason: "It is still starting up; try again in a moment." };
    if (!record.sessionId)
      return {
        status: "unavailable",
        job: record,
        reason: "Its agent session wasn't saved (it was built before messaging, or failed at the start), so it can't be changed; start a new visualization instead.",
      };
    if (!ready()) throw new StudioNotReadyError();
    store.appendLog(id, `${MESSAGE_LINE_PREFIX}${text}`);
    const counted = { ...record, messages: (record.messages ?? 0) + 1 };
    return { status: "resumed", job: resume(counted, [text]) };
  }

  function finish(id: string, result: Awaited<ReturnType<RunAgent>>, slot?: Slot) {
    if (slot) slot.finished = true;
    const reason = slot?.reason;
    const record = store.read(id);
    if (!record || record.status !== "running") return;
    const figure = keepFigure(id);
    const turns = "turns" in result ? result.turns : undefined;
    // the agent's answer to the chat's message(s): what it changed
    const reply = slot?.answered && result.outcome === "success" ? replyFrom(result.summary) : undefined;
    const base = {
      ...record,
      endedAt: now(),
      ...(figure ? { figure } : {}),
      ...(turns ? { turns } : {}),
      ...(reply ? { lastReply: reply } : {}),
    };

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
      finish(id, { outcome: "aborted" }, slot);
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
    sendMessage,
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
