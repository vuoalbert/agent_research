import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where the Visualize studio keeps everything (see scripts/setup-visualize.mjs):
 *
 *   .visualize/plugin/skills/anatomy/   the pinned skill, loaded as studio:anatomy
 *   .visualize/bin/chrome               Chrome for the browser checks
 *   .visualize/jobs/<id>/job.json       the job's record       (runner-owned)
 *   .visualize/jobs/<id>/progress.log   append-only JSON lines (runner-owned)
 *   .visualize/jobs/<id>/figure.html    the served copy        (runner-owned)
 *   .visualize/jobs/<id>/work/          the agent's cwd, the only place it may write
 *
 * The record, the log and the served figure sit beside `work/`, not in it, so
 * nothing the agent runs can rewrite its own status or swap the page after it
 * is done.
 */

export type StudioPaths = {
  studio: string;
  plugin: string;
  skill: string;
  chrome: string;
  jobs: string;
  /** the repo the studio lives in: its `.env*` files are kept from the agent */
  repo: string;
};

export type JobPaths = {
  dir: string;
  record: string;
  log: string;
  /** the runner's copy, the one the figure route serves */
  figure: string;
  work: string;
  /** what the agent writes; copied to `figure` when the job ends */
  workFigure: string;
  /** TMPDIR for the browser checks: Chrome's throwaway profiles land here */
  tmp: string;
};

export function studioPaths(root = process.env.VISUALIZE_STUDIO_DIR): StudioPaths {
  const studio = resolve(root ?? join(process.cwd(), ".visualize"));
  const plugin = join(studio, "plugin");
  return {
    studio,
    plugin,
    skill: join(plugin, "skills", "anatomy"),
    chrome: join(studio, "bin", "chrome"),
    jobs: join(studio, "jobs"),
    repo: dirname(studio),
  };
}

/** ids the runner makes: `20261114-1305-dial-indicator-gauge-a1b2` */
const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export const isJobId = (value: unknown): value is string =>
  typeof value === "string" && JOB_ID.test(value);

export function jobPaths(paths: StudioPaths, id: string): JobPaths {
  if (!isJobId(id)) throw new Error(`not a job id: ${JSON.stringify(id)}`);
  const dir = join(paths.jobs, id);
  const work = join(dir, "work");
  return {
    dir,
    record: join(dir, "job.json"),
    log: join(dir, "progress.log"),
    figure: join(dir, "figure.html"),
    work,
    workFigure: join(work, "figure.html"),
    tmp: join(work, ".tmp"),
  };
}

export function newJobId(subject: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug =
    subject
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "figure";
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${slug}-${suffix}`;
}

/**
 * The real path `target` would have: the deepest part of it that exists, with
 * its links resolved, plus whatever does not exist yet. A link inside the job
 * folder that points out of it therefore resolves outside, where it really goes.
 */
export function realTarget(target: string, base: string): string {
  let head = resolve(base, expandHome(target));
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    /* unreadable: judge the path as written */
  }
  return tail.length ? join(real, ...tail) : real;
}

/** `root` itself or anything under it; both should be real paths */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** a real path for a directory that may sit behind a link (macOS /tmp → /private/tmp) */
export function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** places nothing in the studio has any business reading */
export function secretPaths(paths: StudioPaths): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, "Library", "Keychains"),
    join(paths.repo, ".env"),
    join(paths.repo, ".env.local"),
    join(paths.repo, ".env.development.local"),
    join(paths.repo, ".env.production.local"),
    join(paths.repo, ".git"),
  ];
}
