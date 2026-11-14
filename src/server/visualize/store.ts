import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";

import type { JobRecord, LogLine } from "@/lib/visualize";

import { isJobId, jobPaths, type StudioPaths } from "./paths";

/**
 * The jobs on disk. One folder per job, a `job.json` written whole (temp file
 * and rename, so a reader never sees half of one) and an append-only
 * `progress.log` of JSON lines. Everything survives a dev-server restart; the
 * runner decides what a restart means for a job that was mid-run.
 */

/** a log line is one short line: long tool inputs and replies are cut */
export const MAX_LINE = 240;

export function cleanLine(text: string, max = MAX_LINE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createJobStore(paths: StudioPaths, now: () => number = Date.now) {
  function read(id: string): JobRecord | null {
    if (!isJobId(id)) return null;
    const file = jobPaths(paths, id).record;
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
      return record && record.id === id ? record : null;
    } catch {
      return null;
    }
  }

  function write(record: JobRecord): JobRecord {
    const { dir, record: file } = jobPaths(paths, record.id);
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, file);
    return record;
  }

  function update(id: string, change: Partial<JobRecord>): JobRecord | null {
    const record = read(id);
    return record ? write({ ...record, ...change, id }) : null;
  }

  function list(): JobRecord[] {
    if (!existsSync(paths.jobs)) return [];
    return readdirSync(paths.jobs)
      .filter(isJobId)
      .map(read)
      .filter((record): record is JobRecord => record !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** a job that was discarded (its folder deleted) is not brought back by a late line */
  function appendLog(id: string, text: string) {
    const line = cleanLine(text);
    if (!line) return;
    const { dir, log } = jobPaths(paths, id);
    if (!existsSync(dir)) return;
    appendFileSync(log, `${JSON.stringify({ t: now(), text: line } satisfies LogLine)}\n`);
  }

  function tailLog(id: string, count: number): LogLine[] {
    // slice(-0) would be the whole log
    if (!isJobId(id) || count <= 0) return [];
    const { log } = jobPaths(paths, id);
    if (!existsSync(log)) return [];
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-count);
    const parsed: LogLine[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogLine;
        if (typeof entry.t === "number" && typeof entry.text === "string") parsed.push(entry);
      } catch {
        /* a torn last line from a crash: skip it */
      }
    }
    return parsed;
  }

  return { read, write, update, list, appendLog, tailLog };
}

export type JobStore = ReturnType<typeof createJobStore>;
