import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { VaultNoteView, VaultTree, VaultTreeFolder, VaultTreeNode } from "@/lib/vault-browse";

import { resolveInVault, vaultDir, VaultPathError } from "./files";
import { getField, splitNote, stripMarkers } from "./note";

/**
 * The vault as the References panel browses it: its folder tree (every
 * folder, the app's and the user's, empty ones included) and one note at a
 * time, read-only. Hidden entries (`.obsidian`, `.trash`) and `node_modules`
 * are skipped, and symlinks are never followed — a link cannot lead the
 * browser out of the vault.
 */

const SKIP = /^(\.|node_modules$)/;

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || a.localeCompare(b);

/** folders first, then notes, each alphabetical */
function sortNodes(nodes: VaultTreeNode[]): VaultTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return byName(a.kind === "folder" ? a.name : a.title, b.kind === "folder" ? b.name : b.title);
  });
}

export async function vaultTree(dir = vaultDir()): Promise<VaultTree> {
  const root = path.resolve(dir);
  const notes: { title: string; path: string }[] = [];

  const walk = async (abs: string, rel: string): Promise<VaultTreeNode[]> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: VaultTreeNode[] = [];
    for (const entry of entries) {
      if (SKIP.test(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const folder: VaultTreeFolder = {
          kind: "folder",
          name: entry.name,
          path: childRel,
          children: await walk(childAbs, childRel),
        };
        nodes.push(folder);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const text = await readFile(childAbs, "utf8").catch(() => null);
        if (text === null) continue;
        const { frontmatter } = splitNote(text);
        const title = entry.name.slice(0, -3);
        notes.push({ title, path: childRel });
        nodes.push({
          kind: "note",
          title,
          path: childRel,
          type: getField(frontmatter, "type") || undefined,
          updated: getField(frontmatter, "updated") || undefined,
        });
      }
    }
    return sortNodes(nodes);
  };

  const children = await walk(root, "");
  // a title two folders share resolves the way Obsidian's shortest-path does
  // here: the first in path order
  const titles: Record<string, string> = {};
  for (const note of [...notes].sort((a, b) => byName(a.path, b.path))) {
    const key = note.title.toLowerCase();
    if (!Object.hasOwn(titles, key)) titles[key] = note.path;
  }
  return { children, titles, count: notes.length };
}

/** flat `key: value` lines as a record (YAML lists and nested maps are left out) */
export function frontmatterRecord(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z_][\w-]*):(?:\s|$)/.exec(line);
    if (!match || Object.hasOwn(out, match[1])) continue;
    const value = getField([line], match[1]);
    if (value) out[match[1]] = value;
  }
  return out;
}

/**
 * One note by vault-relative path: only `.md` files inside the vault, no
 * hidden segments, no `..`, no absolute or `~` paths, no symlinks (in the
 * path or out of the vault) — a `VaultPathError` otherwise. `null` when there
 * is no such note.
 */
export async function readVaultNote(relative: string, dir = vaultDir()): Promise<VaultNoteView | null> {
  const rel = relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/\.md$/i.test(rel)) throw new VaultPathError("only .md notes can be read");
  const abs = await resolveInVault(rel, dir);
  if (rel.split("/").some((segment) => segment === "" || SKIP.test(segment))) {
    throw new VaultPathError("hidden or empty path segments are not served");
  }
  // refuse a symlink anywhere along the path, even one that stays in the vault:
  // the tree never lists them, so nothing legitimate links through one
  const root = path.resolve(dir);
  let at = abs;
  while (at.startsWith(root + path.sep)) {
    const stat = await lstat(at).catch(() => null);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) throw new VaultPathError("symlinked notes are not served");
    at = path.dirname(at);
  }
  const text = await readFile(abs, "utf8").catch(() => null);
  if (text === null) return null;
  const { frontmatter, body } = splitNote(text);
  return {
    path: rel,
    title: rel.split("/").pop()!.slice(0, -3),
    frontmatter: frontmatterRecord(frontmatter),
    body: stripMarkers(body).replace(/\n{3,}/g, "\n\n").trim(),
  };
}
