import type { Crossref } from "@/lib/crossref";
import { sourceKey } from "@/lib/source-key";

import { vaultDir } from "./files";
import { writeTurn, type TurnPage, type TurnWrite } from "./write";

/**
 * What one chat turn's research left behind, collected while it streams and
 * written to the vault once it is over. The route feeds it the pages each
 * search/read returned and the tool activity it already reports; `finish`
 * writes the notes (or does nothing for a turn that did no research).
 */
export function createTurnRecorder({
  chatId,
  question,
  knownSources = [],
  dir,
  write = writeTurn,
}: {
  chatId?: string;
  question: string;
  knownSources?: { title: string; url: string }[];
  dir?: string;
  write?: typeof writeTurn;
}) {
  const pages = new Map<string, TurnPage>();
  const crossrefs: Crossref[] = [];
  let researched = false;

  return {
    /** the pages a search (excerpts) or a read (full text) returned */
    recordPages(seen: readonly { url: string; title: string; text: string; full: boolean }[]) {
      researched = true;
      for (const page of seen) {
        const key = sourceKey(page.url);
        const before = pages.get(key);
        pages.set(key, {
          url: page.url,
          title: page.title || before?.title || page.url,
          excerpt: before?.excerpt ?? (page.full ? undefined : page.text),
          text: page.full ? page.text : before?.text,
          read: page.full || Boolean(before?.read),
        });
      }
    },
    /** a `tool` activity frame; a finished cross-reference is kept */
    recordActivity(activity: unknown) {
      if (!activity || typeof activity !== "object") return;
      const event = activity as { status?: string; crossref?: Crossref };
      if (event.status === "done" && event.crossref && Array.isArray(event.crossref.claims)) {
        researched = true;
        crossrefs.push(event.crossref);
      }
    },
    get researched() {
      return researched;
    },
    /** write the turn's notes; never throws — a failed write is logged, not surfaced */
    async finish(answer: string): Promise<TurnWrite | null> {
      if (!researched || !answer.trim()) return null;
      try {
        const result = await write(
          { chatId, question, answer, pages: [...pages.values()], crossrefs, knownSources },
          dir ?? vaultDir(),
        );
        if (result) {
          console.info(
            `[vault] ${result.research}: ${result.sources.length} sources, ${result.claims.length} claims ` +
              `(${result.written.length} notes written)`,
          );
        }
        return result;
      } catch (error) {
        console.warn("[vault] could not write the turn's notes:", error);
        return null;
      }
    },
  };
}

export type TurnRecorder = ReturnType<typeof createTurnRecorder>;
