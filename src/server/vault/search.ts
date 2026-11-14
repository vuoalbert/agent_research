import { readFile } from "node:fs/promises";

import { resolveInVault, scanVault, vaultDir, VaultPathError, type VaultNote } from "./files";
import { getField, listItems, parseSections, readBlock, AUTO_BLOCK, splitNote } from "./note";

/**
 * Finding and reading notes: an in-process scan of the vault's Markdown,
 * which is plenty at the size a personal research vault reaches. Ranked by
 * how many of the query's words the title has, then by how many the body has.
 */

export const MAX_SEARCH_RESULTS = 8;
const SNIPPET_CHARS = 240;
/** how much of one note a read hands back */
export const MAX_READ_CHARS = 12_000;

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from has have how i in is it its many much of on or the this to was were what when where which who why will with".split(
    " ",
  ),
);

/** the query's searchable words: lower-case, stop words dropped, whole query if nothing is left */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  const unique = [...new Set(words)];
  return unique.length ? unique : [query.toLowerCase().trim()].filter(Boolean);
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

function count(haystack: string, needle: string, cap = 10): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && n < cap; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

export type SearchHit = {
  title: string;
  type: string;
  path: string;
  snippet: string;
  updated?: string;
  url?: string;
  titleHits: number;
  bodyHits: number;
};

function snippetOf(body: string, terms: readonly string[]): string {
  const flat = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const folded = fold(flat);
  const at = terms.map((term) => folded.indexOf(term)).filter((i) => i !== -1).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  const snippet = flat.slice(start, start + SNIPPET_CHARS).trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + SNIPPET_CHARS < flat.length ? "…" : ""}`;
}

const typeOf = (note: VaultNote) =>
  note.type ?? ({ Research: "research", Sources: "source", Claims: "claim" } as Record<string, string>)[note.folder] ?? "note";

export function rankNotes(notes: readonly VaultNote[], query: string, limit = MAX_SEARCH_RESULTS): SearchHit[] {
  const terms = queryTerms(query);
  const phrase = fold(query.trim());
  const hits: SearchHit[] = [];
  for (const note of notes) {
    const title = fold(note.title);
    const body = fold(note.body);
    let titleHits = terms.filter((term) => title.includes(term)).length;
    if (phrase.length > 3 && title.includes(phrase)) titleHits += 1;
    const distinct = terms.filter((term) => body.includes(term)).length;
    const total = terms.reduce((sum, term) => sum + count(body, term), 0);
    if (titleHits === 0 && distinct === 0) continue;
    hits.push({
      title: note.title,
      type: typeOf(note),
      path: note.rel,
      snippet: snippetOf(note.body, terms),
      updated: getField(note.frontmatter, "updated"),
      url: getField(note.frontmatter, "url"),
      titleHits,
      // distinct words matter more than one word repeated
      bodyHits: distinct * 100 + total,
    });
  }
  hits.sort((a, b) => b.titleHits - a.titleHits || b.bodyHits - a.bodyHits || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}

export async function searchVault(query: string, dir = vaultDir(), limit = MAX_SEARCH_RESULTS): Promise<SearchHit[]> {
  return rankNotes(await scanVault(dir), query, limit);
}

/** `[[Note|alias]]`, `[[Note#Heading]]`, `Note.md` → `Note` */
export function noteName(reference: string): string {
  return reference
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .split("#")[0]
    .replace(/\.md$/i, "")
    .trim();
}

export type ReadNote = { title: string; path: string; text: string; truncated: boolean; sources: { title: string; url: string }[] };

/** the pages a note stands for: a Source's own URL, a Research note's listed sources */
function sourcesOf(text: string): { title: string; url: string }[] {
  const { frontmatter, body } = splitNote(text);
  const type = getField(frontmatter, "type");
  const url = getField(frontmatter, "url");
  if (type === "source" && url) {
    return [{ title: /^# (.+)$/m.exec(body)?.[1]?.trim() || url, url }];
  }
  if (type !== "research") return [];
  const block = readBlock(body, AUTO_BLOCK);
  if (block === null) return [];
  const section = parseSections(block).sections.find((s) => s.heading === "Sources");
  const out: { title: string; url: string }[] = [];
  for (const item of listItems(section?.body)) {
    const match = /\[\[([^\]|#]+)[^\]]*\]\]\s*—\s*(https?:\/\/\S+)/.exec(item);
    if (match) out.push({ title: match[1].trim(), url: match[2] });
  }
  return out;
}

/**
 * A note by title (as a `[[link]]` names it, case-insensitively) or by
 * vault-relative path. Paths are resolved inside the vault only: `..`,
 * absolute paths and symlinks out are refused with a `VaultPathError`.
 */
export async function readNote(reference: string, dir = vaultDir()): Promise<ReadNote | null> {
  const ref = reference.trim();
  const looksLikePath = /[/\\]/.test(ref) || /\.md$/i.test(ref) || ref.startsWith("~");
  let abs: string | undefined;
  let rel: string | undefined;
  let title: string | undefined;

  if (looksLikePath) {
    abs = await resolveInVault(ref, dir);
    const text = await readFile(abs, "utf8").catch(() => null);
    if (text !== null) {
      rel = ref.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!/\.md$/i.test(rel)) rel = `${rel}.md`;
      title = rel.split("/").pop()!.slice(0, -3);
      return finish(title, rel, text);
    }
    // `Sources/Foo.md` that is not there: fall through to the name
  }
  const name = noteName(ref.split(/[/\\]/).pop() ?? ref).toLowerCase();
  if (!name) return null;
  const notes = await scanVault(dir);
  const note =
    notes.find((n) => n.title.toLowerCase() === name) ??
    notes.find((n) => n.title.toLowerCase().startsWith(name));
  return note ? finish(note.title, note.rel, note.text) : null;
}

function finish(title: string, rel: string, text: string): ReadNote {
  const truncated = text.length > MAX_READ_CHARS;
  return {
    title,
    path: rel,
    text: truncated ? `${text.slice(0, MAX_READ_CHARS)}\n[truncated: first ${MAX_READ_CHARS} of ${text.length} characters]` : text,
    truncated,
    sources: sourcesOf(text),
  };
}

export { VaultPathError };
