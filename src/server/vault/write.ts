import path from "node:path";

import { claimKey, mergeCrossrefs, type Crossref, type Stance } from "@/lib/crossref";
import { hostOf, sourceKey } from "@/lib/source-key";

import {
  isoDate,
  sanitizeTitle,
  scanVault,
  serialize,
  uniqueName,
  vaultDir,
  writeNoteFile,
  type Folder,
  type VaultNote,
} from "./files";
import {
  AUTO_BLOCK,
  SAVED_BLOCK,
  demoteHeadings,
  getField,
  joinNote,
  mergeSections,
  parseSections,
  readBlock,
  renderSections,
  setFields,
  splitNote,
  stripMarkers,
  writeBlock,
  type SectionPolicy,
  type Sections,
} from "./note";

/**
 * Writing notes. Every note has a stable identity in its frontmatter (`type`
 * + `key`), so an update finds the note it wrote before — even after the user
 * renamed the file — and merges into it instead of writing a duplicate.
 *
 * - Source  `key` = the page's `sourceKey` (scheme, `www.`, trailing slash dropped)
 * - Claim   `key` = the claim's `claimKey` (case, spacing, punctuation folded)
 * - Research `key` = chat id + the question's `claimKey`
 */

export const link = (title: string) => `[[${title}]]`;

/** one line of quoted page text, safe inside a list item */
export function inlineQuote(text: string, max = 220): string {
  const flat = stripMarkers(text).replace(/\s+/g, " ").replace(/\[\[|\]\]/g, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** --------------------------------------------------------------- session */

export type Allocation = { title: string; abs: string; existing?: VaultNote };

/** one pass of writes over a snapshot of the vault: names are allocated vault-wide unique */
export function openSession(notes: VaultNote[], dir: string) {
  const taken = new Set(notes.map((note) => note.title.toLowerCase()));
  const byKey = new Map<string, Allocation>();
  for (const note of notes) {
    if (note.type && note.key) byKey.set(`${note.type}\u0000${note.key}`, { title: note.title, abs: note.abs, existing: note });
  }
  return {
    allocate(folder: Folder | "Watch", type: string, key: string, title: string): Allocation {
      const id = `${type}\u0000${key}`;
      const known = byKey.get(id);
      if (known) return known;
      const name = uniqueName(sanitizeTitle(title), taken);
      taken.add(name.toLowerCase());
      const allocation = { title: name, abs: path.join(dir, folder, `${name}.md`) };
      byKey.set(id, allocation);
      return allocation;
    },
  };
}

type Upsert = {
  /** managed frontmatter, rewritten every time */
  fields: Record<string, string | undefined>;
  /** frontmatter written only when the note does not have it yet (`first_seen`, `date`) */
  firstFields?: Record<string, string>;
  sections: Sections;
  policies: Record<string, SectionPolicy>;
  block?: string;
  today: string;
};

/** merge one note's managed parts into whatever is on disk; skips the write when nothing changed */
export async function upsert(allocation: Allocation, update: Upsert): Promise<boolean> {
  const block = update.block ?? AUTO_BLOCK;
  const previous = allocation.existing?.text ?? "";
  const { frontmatter, body } = splitNote(previous);

  let fm = setFields(frontmatter, update.fields);
  for (const [key, value] of Object.entries(update.firstFields ?? {})) {
    if (getField(fm, key) === undefined) fm = setFields(fm, { [key]: value });
  }
  const current = readBlock(body, block);
  const merged = mergeSections(current === null ? null : parseSections(current), update.sections, update.policies);
  const nextBody = writeBlock(body, block, renderSections(merged));

  // `updated` only moves when something else did
  const unchanged = joinNote({ frontmatter: setFields(fm, { updated: getField(frontmatter, "updated") ?? update.today }), body: nextBody });
  if (allocation.existing && unchanged === previous) return false;
  const text = joinNote({ frontmatter: setFields(fm, { updated: update.today }), body: nextBody });
  await writeNoteFile(allocation.abs, text);
  // a second upsert of the same note in one pass merges into this write
  allocation.existing = {
    rel: allocation.existing?.rel ?? "",
    abs: allocation.abs,
    title: allocation.title,
    folder: allocation.existing?.folder ?? "",
    text,
    frontmatter: fm,
    body: nextBody,
  };
  return true;
}

export const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** ------------------------------------------------------------ research turn */

/** a page a turn's search or read returned */
export type TurnPage = { url: string; title: string; excerpt?: string; text?: string; read: boolean };

export type TurnRecord = {
  chatId?: string;
  question: string;
  answer: string;
  pages: TurnPage[];
  crossrefs: Crossref[];
  /** titles for pages the turn did not see itself (the chat's earlier sources) */
  knownSources?: { title: string; url: string }[];
  date?: Date;
};

export type TurnWrite = { research: string; sources: string[]; claims: string[]; written: string[] };

const EXCERPT_CHARS = 500;
const QUESTION_TITLE_CHARS = 80;

/** a question's note title: its first sentence when that says enough ("X? Cross-check sources." → "X") */
export function researchTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  const first = /^(.+?[?!.])(\s|$)/.exec(flat)?.[1];
  const pick = first && first.split(" ").length >= 3 ? first : flat;
  return sanitizeTitle(pick, QUESTION_TITLE_CHARS);
}

/**
 * A source's summary: its search excerpt (query-relevant), else the read text
 * around the first quote a claim took from it (a page's opening is usually its
 * navigation), else the read's opening.
 */
export function excerptOf(page: TurnPage | undefined, quotes: readonly string[] = []): string {
  let raw = page?.excerpt?.trim() || "";
  if (!raw && page?.text) {
    const text = page.text.replace(/\s+/g, " ");
    const at = quotes.map((quote) => text.indexOf(quote.replace(/\s+/g, " ").trim())).find((i) => i >= 0);
    raw = at === undefined ? text : text.slice(Math.max(0, at - 150), at + EXCERPT_CHARS);
    if (at !== undefined && at > 150) raw = `…${raw.replace(/^\S*\s/, "")}`;
  }
  const flat = stripMarkers(raw).replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = flat.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** the http(s) URLs an answer links to, in order */
export function citedUrls(answer: string): string[] {
  return [...answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
}

/**
 * Write (or merge into) the Research note for a turn, a Source note for every
 * page the turn read, cross-referenced or cited, and a Claim note for every
 * cross-referenced claim — all linked to each other with `[[wikilinks]]`.
 * Search hits the turn never used are not written. Returns vault-relative paths.
 */
export function writeTurn(turn: TurnRecord, root = vaultDir()): Promise<TurnWrite | null> {
  return serialize(async () => {
    const answer = stripMarkers(turn.answer).trim();
    const question = turn.question.replace(/\s+/g, " ").trim();
    if (!answer || !question) return null;

    const today = isoDate(turn.date);
    const session = openSession(await scanVault(root), root);
    const crossref = mergeCrossrefs(turn.crossrefs);

    // every page the turn knows about, by sourceKey; a full read wins over an excerpt
    const pages = new Map<string, TurnPage>();
    for (const source of turn.knownSources ?? []) {
      pages.set(sourceKey(source.url), { url: source.url, title: source.title, read: false });
    }
    for (const page of turn.pages) {
      const key = sourceKey(page.url);
      const before = pages.get(key);
      pages.set(key, {
        url: before?.url && before.read ? before.url : page.url,
        title: page.title && page.title !== page.url ? page.title : before?.title || page.title,
        excerpt: before?.excerpt || (!page.read ? page.excerpt || page.text : undefined),
        text: page.read ? page.text || before?.text : before?.text,
        read: page.read || Boolean(before?.read),
      });
    }

    // the sources worth a note: read, cross-referenced, or cited
    const used: string[] = [];
    const use = (url: string) => {
      const key = sourceKey(url);
      if (!used.includes(key)) used.push(key);
      if (!pages.has(key)) pages.set(key, { url, title: hostOf(url), read: false });
    };
    for (const page of turn.pages) if (page.read) use(page.url);
    for (const claim of crossref.claims) for (const source of claim.sources) use(source.url);
    for (const url of citedUrls(answer)) use(url);

    const researchKey = `${turn.chatId || "chat"}:${claimKey(question).slice(0, 160)}`;
    const research = session.allocate("Research", "research", researchKey, researchTitle(question));
    const sourceNotes = new Map(
      used.map((key) => {
        const page = pages.get(key)!;
        const title = page.title && page.title !== page.url ? page.title : hostOf(page.url);
        return [key, session.allocate("Sources", "source", key, title)] as const;
      }),
    );
    const claimNotes = crossref.claims.map((claim) => ({
      claim,
      note: session.allocate("Claims", "claim", claimKey(claim.text), claim.text),
    }));

    const written: string[] = [];
    const mark = (changed: boolean, abs: string) => {
      if (changed) written.push(relOf(root, abs));
    };

    // Research
    const quoteLines = turn.question.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    mark(
      await upsert(research, {
        today,
        fields: { type: "research", key: researchKey, chat_id: turn.chatId },
        firstFields: { date: today },
        sections: {
          preamble: `# ${research.title}\n\n${quoteLines}`,
          sections: [
            { heading: "Answer", body: demoteHeadings(answer) },
            {
              heading: "Sources",
              body: used.map((key) => `- ${link(sourceNotes.get(key)!.title)} — ${pages.get(key)!.url}`).join("\n"),
            },
            { heading: "Claims", body: claimNotes.map(({ note }) => `- ${link(note.title)}`).join("\n") },
          ],
        },
        policies: { Answer: "replace", Sources: "list", Claims: "list" },
      }),
      research.abs,
    );

    // Sources
    for (const key of used) {
      const note = sourceNotes.get(key)!;
      const page = pages.get(key)!;
      const quotes: string[] = [];
      const claimLines: string[] = [];
      for (const { claim, note: claimNote } of claimNotes) {
        for (const source of claim.sources) {
          if (sourceKey(source.url) !== key) continue;
          quotes.push(source.quote);
          const quote = inlineQuote(source.quote);
          claimLines.push(`- ${source.stance} ${link(claimNote.title)}${quote ? ` — "${quote}"` : ""}`);
        }
      }
      const excerpt = excerptOf(page, quotes);
      mark(
        await upsert(note, {
          today,
          fields: { type: "source", url: page.url, key, host: hostOf(page.url) },
          firstFields: { first_seen: today },
          sections: {
            preamble: [`# ${inlineQuote(page.title || note.title, 200)}`, page.url, excerpt ? `> ${excerpt}` : ""]
              .filter(Boolean)
              .join("\n\n"),
            sections: [
              { heading: "Claims", body: claimLines.join("\n") },
              { heading: "Research", body: `- ${link(research.title)}` },
            ],
          },
          policies: { Claims: "list", Research: "list" },
        }),
        note.abs,
      );
    }

    // Claims
    const headings: Record<Stance, string> = {
      supports: "Supported by",
      contradicts: "Contradicted by",
      mentions: "Mentioned by",
    };
    for (const { claim, note } of claimNotes) {
      const by: Record<Stance, string[]> = { supports: [], contradicts: [], mentions: [] };
      for (const source of claim.sources) {
        const sourceNote = sourceNotes.get(sourceKey(source.url));
        if (!sourceNote) continue;
        const quote = inlineQuote(source.quote);
        by[source.stance].push(`- ${link(sourceNote.title)}${quote ? ` — "${quote}"` : ""}`);
      }
      mark(
        await upsert(note, {
          today,
          fields: { type: "claim", key: claimKey(claim.text) },
          sections: {
            preamble: `# ${inlineQuote(claim.text, 400)}`,
            sections: [
              ...(Object.keys(headings) as Stance[]).map((stance) => ({ heading: headings[stance], body: by[stance].join("\n") })),
              { heading: "Part of", body: `- ${link(research.title)}` },
            ],
          },
          policies: { "Supported by": "list", "Contradicted by": "list", "Mentioned by": "list", "Part of": "list" },
        }),
        note.abs,
      );
    }

    return {
      research: relOf(root, research.abs),
      sources: used.map((key) => relOf(root, sourceNotes.get(key)!.abs)),
      claims: claimNotes.map(({ note }) => relOf(root, note.abs)),
      written,
    };
  });
}

/** ------------------------------------------------------------- saved note */

const FOLDER_TYPES: Record<Folder, string> = { Research: "research", Sources: "source", Claims: "claim", Notes: "note" };
export const MAX_SAVED_CHARS = 40_000;

/**
 * Claude saving a note on request (`vault_write`). The note is found by its
 * file name in that folder (case-insensitive) — so saving onto an auto-written
 * note adds to it — and its content goes in its own managed block, which the
 * auto-writer never touches, and vice versa. User text outside both is kept.
 */
export function writeSavedNote(
  { title, folder, content }: { title: string; folder: Folder; content: string },
  root = vaultDir(),
): Promise<{ rel: string; title: string; created: boolean }> {
  return serialize(async () => {
    const notes = await scanVault(root);
    const name = sanitizeTitle(title);
    const existing = notes.find((note) => note.folder === folder && note.title.toLowerCase() === name.toLowerCase());
    const taken = new Set(notes.map((note) => note.title.toLowerCase()));
    const finalName = existing?.title ?? uniqueName(name, taken);
    const abs = existing?.abs ?? path.join(root, folder, `${finalName}.md`);

    const { frontmatter, body } = splitNote(existing?.text ?? "");
    let fm = setFields(frontmatter, { updated: isoDate() });
    if (getField(fm, "type") === undefined) fm = setFields(fm, { type: FOLDER_TYPES[folder] });
    if (getField(fm, "key") === undefined && !existing) fm = setFields(fm, { key: `${FOLDER_TYPES[folder]}:${claimKey(finalName)}` });
    // `type` first on a new note, the way the auto-writer orders it
    if (!existing) fm = [fm.find((line) => line.startsWith("type:"))!, ...fm.filter((line) => !line.startsWith("type:"))];

    const clean = stripMarkers(content).trim().slice(0, MAX_SAVED_CHARS);
    const nextBody = writeBlock(body, SAVED_BLOCK, clean || `# ${finalName}`);
    await writeNoteFile(abs, joinNote({ frontmatter: fm, body: nextBody }));
    return { rel: relOf(root, abs), title: finalName, created: !existing };
  });
}
