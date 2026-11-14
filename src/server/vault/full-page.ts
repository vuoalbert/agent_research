import { readFile } from "node:fs/promises";

import { sourceKey } from "@/lib/source-key";

import { isoDate, resolveInVault, serialize, vaultDir, VaultPathError, writeNoteFile } from "./files";
import { demoteHeadings, getField, joinNote, setFields, splitNote, stripMarkers, writeBlock } from "./note";

/**
 * A source note's full page, saved on request: References' "Save to vault"
 * after "Read full page". The page text Telem read goes in a managed block of
 * its own at the end of the note —
 *
 *   <!-- agent-research:page:start -->
 *   ## Full page
 *   _Read by Telem (firecrawl) on 2026-11-14 from <url>_
 *   …the page…
 *   <!-- agent-research:page:end -->
 *
 * — which a second save replaces, and which the auto-writer and `vault_write`
 * never touch (nor it them). Only a note that names that page in its `url`
 * field takes it, so a request cannot write a page into an unrelated note.
 */

export const PAGE_BLOCK = "agent-research:page";
export const MAX_PAGE_CHARS = 40_000;

export type FullPage = { url: string; title: string; text: string; provider: string };

export class FullPageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function fullPageBlock(page: FullPage, date = isoDate()): string {
  const via = page.provider ? `Telem (${page.provider})` : "Telem";
  const text = demoteHeadings(stripMarkers(page.text).replace(/\r\n/g, "\n").trim().slice(0, MAX_PAGE_CHARS));
  return [`## Full page`, "", `_Read by ${via} on ${date} from <${page.url}>_`, "", text].join("\n");
}

export function saveFullPage(relative: string, page: FullPage, root = vaultDir()): Promise<{ path: string }> {
  return serialize(async () => {
    const rel = relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!/\.md$/i.test(rel) || rel.split("/").some((segment) => segment === "" || segment.startsWith("."))) {
      throw new VaultPathError("only .md notes can take a page");
    }
    const abs = await resolveInVault(rel, root);
    const text = await readFile(abs, "utf8").catch(() => null);
    if (text === null) throw new FullPageError("no such note", 404);
    const { frontmatter, body } = splitNote(text);
    const url = getField(frontmatter, "url");
    if (!url || sourceKey(url) !== sourceKey(page.url)) throw new FullPageError("the note is not about that page", 409);
    const fm = setFields(frontmatter, { updated: isoDate() });
    await writeNoteFile(abs, joinNote({ frontmatter: fm, body: writeBlock(body, PAGE_BLOCK, fullPageBlock(page)) }));
    return { path: rel };
  });
}
