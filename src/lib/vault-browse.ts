/**
 * What the References panel reads from the vault, shared by the API routes
 * (`/api/vault/tree`, `/api/vault/note`) and the panel: the response shapes,
 * `[[wikilink]]` resolution against the tree's title map, and turning a
 * note's wikilinks into links the panel can intercept. Pure, no filesystem.
 */

export type VaultTreeNote = {
  kind: "note";
  /** the file name without `.md` — what `[[links]]` name */
  title: string;
  /** vault-relative, forward slashes: `Sources/Minecraft.md` */
  path: string;
  type?: string;
  updated?: string;
};

export type VaultTreeFolder = {
  kind: "folder";
  name: string;
  /** vault-relative, forward slashes, no trailing slash: `Research` */
  path: string;
  children: VaultTreeNode[];
};

export type VaultTreeNode = VaultTreeFolder | VaultTreeNote;

export type VaultTree = {
  /** the vault root's folders (alphabetical) then its root-level notes */
  children: VaultTreeNode[];
  /** lower-cased note title → its path, for resolving `[[links]]` */
  titles: Record<string, string>;
  /** how many notes in all */
  count: number;
};

export type VaultNoteView = {
  path: string;
  title: string;
  /** flat `key: value` frontmatter fields, unquoted */
  frontmatter: Record<string, string>;
  /** the note's Markdown, managed-section markers removed (their content kept) */
  body: string;
};

/** `Note|alias`, `Note#Heading`, `Folder/Note.md` → `note` (the lookup key) */
export function wikilinkKey(target: string): string {
  return (
    target
      .split("|")[0]
      .split("#")[0]
      .trim()
      .replace(/\.md$/i, "")
      .split("/")
      .pop() ?? ""
  )
    .trim()
    .toLowerCase();
}

/** the vault path a `[[target]]` names, or `undefined` when no note has that title */
export function resolveWikilink(target: string, titles: Readonly<Record<string, string>>): string | undefined {
  const key = wikilinkKey(target);
  if (!key) return undefined;
  return Object.hasOwn(titles, key) ? titles[key] : undefined;
}

/** a note href the panel intercepts instead of following */
export const NOTE_HREF_PREFIX = "#vault-note=";
/** the href of a `[[link]]` to a note the vault does not have */
export const MISSING_HREF = "#vault-missing";

export function noteHref(path: string): string {
  return `${NOTE_HREF_PREFIX}${encodeURIComponent(path)}`;
}

/** the vault path in a `noteHref`, or null for any other href */
export function pathFromHref(href: string | null | undefined): string | null {
  if (!href?.startsWith(NOTE_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(NOTE_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/** fenced code blocks and inline code spans, which keep their `[[…]]` literal */
const CODE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\3[`~]*[ \t]*(?=\n|$)|$)|(`+)[^`\n][\s\S]*?\4(?!`)/g;
const WIKILINK = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/** text safe inside a Markdown link label */
const escapeLabel = (text: string) => text.replace(/([\\[\]*_`<>])/g, "\\$1");

/**
 * Every `[[Target]]` / `[[Target|Label]]` / `[[Target#Heading]]` outside code
 * as a Markdown link: to `noteHref(path)` when the vault has the note, to
 * `MISSING_HREF` (rendered muted and inert) when it does not. Embeds
 * (`![[…]]`) become the same links — the panel does not inline them.
 */
export function linkifyWikilinks(markdown: string, titles: Readonly<Record<string, string>>): string {
  const rewrite = (prose: string) =>
    prose.replace(WIKILINK, (_match, _embed: string, inner: string) => {
      const [target, alias] = inner.split("|");
      const label = (alias ?? target).trim() || target.trim();
      const path = resolveWikilink(target, titles);
      return `[${escapeLabel(label)}](${path ? noteHref(path) : MISSING_HREF})`;
    });
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(CODE)) {
    const start = match.index + (match[1]?.length ?? 0);
    out += rewrite(markdown.slice(last, start)) + markdown.slice(start, match.index + match[0].length);
    last = match.index + match[0].length;
  }
  return out + rewrite(markdown.slice(last));
}

/**
 * Every entry that disagrees with a claim — the items of a `## Contradicted
 * by` section (a Claim note) and `- contradicts [[…]]` items (a Source note) —
 * wrapped in `<ins>`, the one inline tag the Markdown renderer keeps, so the
 * panel can set them in the app's conflict red. Fenced code is left alone.
 */
export function markContradictions(markdown: string): string {
  let fenced = false;
  let section = "";
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        section = heading[1].toLowerCase();
        return line;
      }
      const item = /^(\s*[-*+]\s+)(.+)$/.exec(line);
      if (!item) return line;
      if (section === "contradicted by" || /^contradicts\b/i.test(item[2])) return `${item[1]}<ins>${item[2]}</ins>`;
      return line;
    })
    .join("\n");
}
