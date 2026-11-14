import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { WorldRecord } from "@/lib/worlds";

/**
 * The worlds on disk: one JSON record per chat in `.worlds/` (git-ignored; the
 * repo is public), written whole through a temp file and a rename so a reader
 * never sees half of one. Splats are never downloaded — the record keeps the
 * World Labs CDN URLs and the viewer streams from there.
 */

export function worldsDir(root = process.env.WORLDS_DIR): string {
  return resolve(root ?? join(process.cwd(), ".worlds"));
}

/** a chat id as a file name: readable where it can be, unique always */
export function recordFile(dir: string, chatId: string): string {
  const slug = chatId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "chat";
  const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 10);
  return join(dir, `${slug}-${hash}.json`);
}

export function createWorldStore(dir = worldsDir()) {
  function read(chatId: string): WorldRecord | null {
    const file = recordFile(dir, chatId);
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as WorldRecord;
      return record && record.chatId === chatId ? record : null;
    } catch {
      return null;
    }
  }

  function write(record: WorldRecord): WorldRecord {
    mkdirSync(dir, { recursive: true });
    const file = recordFile(dir, record.chatId);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, file);
    return record;
  }

  function update(chatId: string, change: Partial<WorldRecord>, now = Date.now()): WorldRecord | null {
    const record = read(chatId);
    return record ? write({ ...record, ...change, chatId, updatedAt: now }) : null;
  }

  function list(): WorldRecord[] {
    if (!existsSync(dir)) return [];
    const records: WorldRecord[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as WorldRecord;
        if (record && typeof record.chatId === "string") records.push(record);
      } catch {
        /* a torn or hand-edited file: skip it */
      }
    }
    return records;
  }

  return { dir, read, write, update, list };
}

export type WorldStore = ReturnType<typeof createWorldStore>;
