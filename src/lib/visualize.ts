/**
 * Visualize jobs as the browser sees them: the shapes `/api/visualize/*`
 * returns, and the few helpers the tool row and the Visualize view share.
 * There is only ever one visualization at a time (see
 * src/server/visualize/runner.ts); a job that was replaced is gone.
 * Isomorphic on purpose — no Node imports — so client components can use it;
 * the runner that produces these lives in `src/server/visualize/`.
 */

export type JobStatus = "queued" | "running" | "done" | "error" | "stopped" | "interrupted";

/** what `jobs/<id>/job.json` holds */
export type JobRecord = {
  id: string;
  subject: string;
  brief?: string;
  /** "research" when the chat queued it after a research turn, "chat" when Claude called the tool */
  origin?: "chat" | "research";
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** set once the runner has a copy of the finished page to serve */
  figure?: "figure.html";
  /** why it failed, stopped or was interrupted */
  error?: string;
  /** anything else worth saying about how it ended */
  note?: string;
  /** the server process that queued or ran it, so a restart can tell its own jobs from orphans */
  pid?: number;
  turns?: number;
};

/** one line of `jobs/<id>/progress.log` */
export type LogLine = { t: number; text: string };

/** a job in the list: its record, how long it has run, and its latest line */
export type JobSummary = JobRecord & { elapsedMs: number; lastLine?: string };

/** one job in full: its summary and its latest log lines, oldest first */
export type JobDetail = JobSummary & { log: LogLine[] };

export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "running"];

export const isActive = (status: JobStatus | undefined) =>
  status !== undefined && ACTIVE_STATUSES.includes(status);

/** the one visualization there is: `{ job: JobDetail | null }` */
export const CURRENT_ENDPOINT = "/api/visualize/current";
export const JOBS_ENDPOINT = "/api/visualize/jobs";
export const jobEndpoint = (id: string) => `${JOBS_ENDPOINT}/${encodeURIComponent(id)}`;
export const figureEndpoint = (id: string) => `${jobEndpoint(id)}/figure`;
export const stopEndpoint = (id: string) => `${jobEndpoint(id)}/stop`;

/** how often the view and a running tool row ask for news */
export const POLL_MS = 3000;

/** "42s", "3m 05s", "1h 02m" */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
