import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getField, splitNote } from "./note";

/**
 * Where the vault lives and how notes are found in it. The vault is a plain
 * folder Obsidian can open: `Research/`, `Sources/`, `Claims/`, `Notes/`, one
 * `.md` file per note. It is created on first write.
 *
 * `<repo>/vault/` by default (git-ignored — the repo is public, research notes
 * are not), or `VAULT_DIR`.
 */

export const FOLDERS = ["Research", "Sources", "Claims", "Notes"] as const;
export type Folder = (typeof FOLDERS)[number];

export function vaultDir(): string {
  const configured = process.env.VAULT_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), "vault"));
}

/** ------------------------------------------------------------ file names */

/** the longest file name (without `.md`) a note gets */
export const MAX_TITLE_CHARS = 90;

/**
 * A title as a file name Obsidian can link to: no `\ / : * ? " < > | # ^ [ ]`
 * (path separators, characters file systems or wikilinks reserve), no control
 * characters, no leading dot (a hidden file), collapsed whitespace, cut on a
 * word boundary.
 */
export function sanitizeTitle(title: string, max = MAX_TITLE_CHARS): string {
  let name = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s*:\s*/g, " - ")
    .replace(/[\\/]/g, "-")
    .replace(/\s*\|\s*/g, " - ")
    .replace(/[*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s-]+/, "");
  if (name.length > max) {
    const cut = name.slice(0, max);
    const space = cut.lastIndexOf(" ");
    name = space > max * 0.6 ? cut.slice(0, space) : cut;
  }
  name = name.replace(/[\s.,;\-–—]+$/, "");
  if (!name) return "Untitled";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return `${name} note`;
  return name;
}

/** `name`, or `name (2)`, `name (3)`… — whichever is free across the whole vault */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** ---------------------------------------------------------- safe resolve */

export class VaultPathError extends Error {}

/**
 * A vault-relative note path as an absolute one, or a `VaultPathError`:
 * absolute paths, drive letters, `..` segments, NUL bytes and anything that
 * resolves (symlinks included) outside the vault are refused. `.md` is implied.
 */
export async function resolveInVault(relative: string, dir = vaultDir()): Promise<string> {
  const raw = relative.trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) throw new VaultPathError("empty or invalid note path");
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("~")) {
    throw new VaultPathError("note paths are relative to the vault");
  }
  if (raw.split("/").some((segment) => segment === "..")) {
    throw new VaultPathError("note paths may not contain ..");
  }
  const withExt = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
  const root = path.resolve(dir);
  const target = path.resolve(root, withExt);
  if (!target.startsWith(root + path.sep)) throw new VaultPathError("note path is outside the vault");
  // a symlink inside the vault must not lead out of it
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!realTarget.startsWith(realRoot + path.sep)) throw new VaultPathError("note path is outside the vault");
  } catch (error) {
    if (error instanceof VaultPathError) throw error;
    // a note that does not exist yet has no real path; the lexical check stands
  }
  return target;
}

/** ------------------------------------------------------------------ scan */

export type VaultNote = {
  /** vault-relative, forward slashes: `Sources/Minecraft.md` */
  rel: string;
  abs: string;
  /** the file name without `.md` — what `[[links]]` name */
  title: string;
  /** the top-level folder, or "" for a note at the root */
  folder: string;
  text: string;
  frontmatter: string[];
  body: string;
  type?: string;
  key?: string;
};

const SKIP_DIR = /^(\.|node_modules$)/;

/** every `.md` note under the vault (hidden folders like `.obsidian` skipped); none if it does not exist */
export async function scanVault(dir = vaultDir()): Promise<VaultNote[]> {
  const root = path.resolve(dir);
  const notes: VaultNote[] = [];
  const walk = async (folder: string) => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR.test(entry.name)) await walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const text = await readFile(abs, "utf8").catch(() => null);
        if (text === null) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const { frontmatter, body } = splitNote(text);
        notes.push({
          rel,
          abs,
          title: entry.name.slice(0, -3),
          folder: rel.includes("/") ? rel.split("/")[0] : "",
          text,
          frontmatter,
          body,
          type: getField(frontmatter, "type"),
          key: getField(frontmatter, "key"),
        });
      }
    }
  };
  await walk(root);
  notes.sort((a, b) => a.rel.localeCompare(b.rel));
  return notes;
}

/** ----------------------------------------------------------------- write */

/** write via a temp file and rename, so Obsidian never reads half a note */
export async function writeNoteFile(abs: string, text: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, abs);
}

let queue: Promise<unknown> = Promise.resolve();

/** run vault writes one at a time, so two turns finishing together cannot clobber one note */
export function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** today as `YYYY-MM-DD`, local time */
export function isoDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
