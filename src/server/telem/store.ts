import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What each chat watches, kept server-side in `<repo>/.telem/` (git-ignored;
 * `TELEM_DIR` overrides it): one JSON file per chat with its monitors, the
 * cursor each one's change stream has been read to, and what the reads
 * turned up — findings (one per change worth showing) and sources (pages the
 * findings came from), which the Knowledge base merges into the chat's own.
 *
 * "New" is anything ingested after the chat last marked its watch as seen.
 */

export type WatchMonitor = {
  id: string;
  query: string;
  frequency: string;
  /** created on its own after the chat's first research turn, not by a tool call */
  auto: boolean;
  createdAt: string;
  /** the `next_cursor` of the last changes read */
  cursor: number;
  lastIngestAt?: string;
  /** set when the monitor was deleted from this app: no more reads */
  deleted?: boolean;
};

export type WatchFinding = {
  seq: number;
  monitorId: string;
  kind: string;
  name: string;
  detail?: string;
  url?: string;
  at: string;
  ingestedAt: string;
};

export type WatchSource = { title: string; url: string; monitorId: string; ingestedAt: string };

export type ChatWatch = {
  chatId: string;
  monitors: WatchMonitor[];
  findings: WatchFinding[];
  sources: WatchSource[];
  /** ISO time the chat last saw its watch's news */
  seenAt?: string;
};

/** the most findings a chat keeps (oldest dropped) */
export const MAX_FINDINGS = 300;
export const MAX_SOURCES = 200;

export function telemDir(): string {
  const configured = process.env.TELEM_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), ".telem"));
}

const fileName = (chatId: string) => `${chatId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "chat"}.json`;
const chatsDir = (dir: string) => path.join(dir, "chats");

const empty = (chatId: string): ChatWatch => ({ chatId, monitors: [], findings: [], sources: [] });

export async function readChatWatch(chatId: string, dir = telemDir()): Promise<ChatWatch> {
  try {
    const parsed = JSON.parse(await readFile(path.join(chatsDir(dir), fileName(chatId)), "utf8")) as ChatWatch;
    return {
      ...empty(chatId),
      ...parsed,
      monitors: Array.isArray(parsed.monitors) ? parsed.monitors : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch {
    return empty(chatId);
  }
}

let queue: Promise<unknown> = Promise.resolve();
/** one write at a time, so the poller and a tool call cannot clobber a chat's file */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** read, change and write back one chat's record */
export function updateChatWatch(
  chatId: string,
  change: (watch: ChatWatch) => ChatWatch | void,
  dir = telemDir(),
): Promise<ChatWatch> {
  return serialize(async () => {
    const current = await readChatWatch(chatId, dir);
    const next = change(current) ?? current;
    next.findings = next.findings.slice(-MAX_FINDINGS);
    next.sources = next.sources.slice(-MAX_SOURCES);
    const target = path.join(chatsDir(dir), fileName(chatId));
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
    await rename(temp, target);
    return next;
  });
}

export async function listChatWatches(dir = telemDir()): Promise<ChatWatch[]> {
  let names: string[];
  try {
    names = await readdir(chatsDir(dir));
  } catch {
    return [];
  }
  const watches: ChatWatch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(chatsDir(dir), name), "utf8")) as ChatWatch;
      if (parsed?.chatId) watches.push(await readChatWatch(parsed.chatId, dir));
    } catch {
      /* a half-written or foreign file: skip it */
    }
  }
  return watches;
}

/** which chat a monitor belongs to, if this app made it */
export async function findMonitor(
  monitorId: string,
  dir = telemDir(),
): Promise<{ chatId: string; monitor: WatchMonitor } | null> {
  for (const watch of await listChatWatches(dir)) {
    const monitor = watch.monitors.find((m) => m.id === monitorId);
    if (monitor) return { chatId: watch.chatId, monitor };
  }
  return null;
}

/** what is new since the chat last looked */
export function unseen(watch: ChatWatch): { findings: WatchFinding[]; sources: WatchSource[] } {
  const since = watch.seenAt ?? "";
  return {
    findings: watch.findings.filter((f) => f.ingestedAt > since),
    sources: watch.sources.filter((s) => s.ingestedAt > since),
  };
}
