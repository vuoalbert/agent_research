/**
 * The text model of one vault note, pure (no filesystem):
 *
 *   ---                         YAML frontmatter, flat `key: value` lines.
 *   type: source                Lines this app manages are rewritten in place;
 *   key: example.com/page       every other line (the user's tags, aliases…)
 *   ---                         is kept verbatim.
 *   <!-- agent-research:start -->
 *   # Title                     The managed block: the app rewrites what is
 *   ## Claims                   between the markers, merging list sections
 *   - supports [[…]] — "…"      (append + de-duplicate) rather than replacing
 *   <!-- agent-research:end -->
 *   Anything the user wrote out here is never touched.
 *
 * Obsidian reads all of this as an ordinary note: frontmatter becomes
 * properties, the markers are invisible HTML comments, `[[links]]` resolve by
 * file name.
 */

/** the block auto-written research lives in */
export const AUTO_BLOCK = "agent-research";
/** the block `vault_write` (Claude saving a note on request) lives in */
export const SAVED_BLOCK = "agent-research:saved";

const startMarker = (id: string) => `<!-- ${id}:start -->`;
const endMarker = (id: string) => `<!-- ${id}:end -->`;

/** any of our markers, so text from a page or a model cannot forge one */
const ANY_MARKER = /<!--\s*agent-research(?::[\w-]+)?:(?:start|end)\s*-->/gi;

export function stripMarkers(text: string): string {
  return text.replace(ANY_MARKER, "");
}

/** ----------------------------------------------------------- frontmatter */

export type NoteText = { frontmatter: string[]; body: string };

export function splitNote(text: string): NoteText {
  const normalised = text.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return { frontmatter: [], body: normalised };
  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: [], body: normalised };
  const after = normalised.slice(end + 4);
  // the closing fence must be a whole line
  if (after !== "" && !after.startsWith("\n")) return { frontmatter: [], body: normalised };
  return {
    frontmatter: normalised.slice(4, end).split("\n"),
    body: after.startsWith("\n") ? after.slice(1) : after,
  };
}

export function joinNote({ frontmatter, body }: NoteText): string {
  if (frontmatter.length === 0) return body;
  return `---\n${frontmatter.join("\n")}\n---\n${body}`;
}

const fieldLine = (key: string) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s?(.*)$`);

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function getField(frontmatter: readonly string[], key: string): string | undefined {
  const pattern = fieldLine(key);
  for (const line of frontmatter) {
    const match = pattern.exec(line);
    if (match) return unquote(match[1]);
  }
  return undefined;
}

/** a YAML scalar: plain when it is unambiguous, otherwise a JSON (= YAML double-quoted) string */
export function yamlValue(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 _.\-/]*$/.test(value) && !/\s$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/** set (or, with `undefined`, leave alone) each field, in place or appended */
export function setFields(frontmatter: readonly string[], fields: Record<string, string | undefined>): string[] {
  const lines = [...frontmatter];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const pattern = fieldLine(key);
    const line = `${key}: ${yamlValue(value)}`;
    const at = lines.findIndex((existing) => pattern.test(existing));
    if (at === -1) lines.push(line);
    else lines[at] = line;
  }
  return lines;
}

/** ---------------------------------------------------------- managed block */

export function readBlock(body: string, id: string): string | null {
  const start = body.indexOf(startMarker(id));
  if (start === -1) return null;
  const from = start + startMarker(id).length;
  const end = body.indexOf(endMarker(id), from);
  if (end === -1) return null;
  return body.slice(from, end).replace(/^\n/, "").replace(/\n$/, "");
}

/** replace the block's content, or add the block (first for a new note, last otherwise) */
export function writeBlock(body: string, id: string, content: string): string {
  const block = `${startMarker(id)}\n${content.trim()}\n${endMarker(id)}`;
  const start = body.indexOf(startMarker(id));
  const end = start === -1 ? -1 : body.indexOf(endMarker(id), start);
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + block + body.slice(end + endMarker(id).length);
  }
  if (body.trim() === "") return `${block}\n`;
  return `${body.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** -------------------------------------------------------------- sections */

export type Sections = { preamble: string; sections: { heading: string; body: string }[] };

/** split on `## ` headings outside fenced code */
export function parseSections(content: string): Sections {
  const result: Sections = { preamble: "", sections: [] };
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const done: { heading: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^## (.+?)\s*$/.exec(line);
    if (heading) {
      if (current) done.push(current);
      current = { heading: heading[1], lines: [] };
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) done.push(current);
  result.preamble = preamble.join("\n").trim();
  result.sections = done.map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }));
  return result;
}

export function renderSections({ preamble, sections }: Sections): string {
  const parts = preamble ? [preamble] : [];
  for (const section of sections) {
    if (!section.body.trim()) continue;
    parts.push(`## ${section.heading}\n${section.body.trim()}`);
  }
  return parts.join("\n\n");
}

/** the `- ` items of a list section */
export function listItems(body: string | undefined): string[] {
  return (body ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "));
}

/**
 * What makes two list items the same entry: the stance word (if any) and the
 * first `[[link]]` target, case-insensitively — so the same source supporting
 * the same claim with a re-worded quote is one line, not two. Items without a
 * link compare by their whole text.
 */
export function itemKey(item: string): string {
  const stance = /^- (supports|contradicts|mentions)\b/i.exec(item)?.[1]?.toLowerCase() ?? "";
  const link = /\[\[([^\]|#]+)/.exec(item)?.[1];
  if (link) return `${stance}\u0000${link.trim().toLowerCase()}`;
  return item.toLowerCase().replace(/\s+/g, " ").trim();
}

/** existing items first, in their order, then each new one not already there */
export function mergeItems(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing.map(itemKey));
  const out = [...existing];
  for (const item of incoming) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export type SectionPolicy = "list" | "replace";

/**
 * Merge freshly built sections into what a note already has: list sections
 * union their items, `replace` sections take the new text when it has any.
 * The preamble is kept once written (the title and excerpt do not churn).
 * Sections the note has but this update does not mention stay as they were.
 */
export function mergeSections(
  existing: Sections | null,
  incoming: Sections,
  policies: Record<string, SectionPolicy>,
): Sections {
  if (!existing) return incoming;
  const out: Sections = { preamble: existing.preamble || incoming.preamble, sections: [] };
  const incomingBy = new Map(incoming.sections.map((section) => [section.heading.toLowerCase(), section]));
  const used = new Set<string>();
  for (const section of existing.sections) {
    const key = section.heading.toLowerCase();
    const next = incomingBy.get(key);
    used.add(key);
    if (!next) {
      out.sections.push(section);
    } else if ((policies[section.heading] ?? policies[next.heading]) === "replace") {
      out.sections.push(next.body.trim() ? next : section);
    } else {
      out.sections.push({
        heading: section.heading,
        body: mergeItems(listItems(section.body), listItems(next.body)).join("\n"),
      });
    }
  }
  for (const section of incoming.sections) {
    if (!used.has(section.heading.toLowerCase())) out.sections.push(section);
  }
  return out;
}

/** `#`/`##` headings in embedded markdown pushed to `###`, so they cannot open a managed section */
export function demoteHeadings(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/^#{1,2}(?=\s)/, "###");
    })
    .join("\n");
}
