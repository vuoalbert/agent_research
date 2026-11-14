import { mergeCrossrefs, type Crossref } from "@/lib/crossref";
import { sourceKey } from "@/lib/source-key";
import { WORLD_TOOL_NAME, type WorldSource } from "@/lib/worlds";
import { getWorldService, type WorldService } from "@/server/worlds/service";

import { subjectFrom } from "./visualize-tool";

/**
 * The chat's World Labs world, started after its FIRST research turn.
 *
 * One `createWorldTurn` per request, beside the vault recorder and the
 * Visualize fallback but separate from both: it watches the turn's SDK
 * messages for research calls (search, read, cross-reference, subagents),
 * keeps the turn's cross-reference claims and the pages it saw, and once the
 * turn has finished normally, `finish` starts the chat's world in the
 * background — unless the chat already has one (any later research turn, or a
 * turn racing the first, does nothing). A started world is reported as one
 * `tool` row:
 *
 *   {"id","name":"World Labs","action":"world","query":<subject>,"chatId","status":"running"} → {"id","status":"done"}
 *
 * The row then follows the world itself (its title once Claude has named the
 * scene, "generating" → "ready"), as a Visualize row follows its job.
 */

export type WorldActivity =
  | { id: string; name: typeof WORLD_TOOL_NAME; action: "world"; query: string; chatId: string; status: "running" }
  | { id: string; status: "done" };

export function createWorldTurn({
  chatId,
  onActivity,
  researchTools,
  knownSources = [],
  service = getWorldService,
}: {
  chatId?: string;
  onActivity: (activity: WorldActivity) => void;
  /** the tool names (as Claude Code knows them) that count as research */
  researchTools: readonly string[];
  /** the chat's sources before this turn */
  knownSources?: readonly WorldSource[];
  service?: () => WorldService | null;
}) {
  let researched = false;
  const crossrefs: Crossref[] = [];
  const sources = new Map<string, WorldSource>();
  for (const source of knownSources) sources.set(sourceKey(source.url), { title: source.title, url: source.url });

  return {
    /** see each SDK message: a research tool call marks the turn as research */
    observe(message: unknown) {
      const m = message as { type?: string; message?: { content?: unknown } };
      if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) return;
      for (const block of m.message.content as { type?: string; name?: string }[]) {
        if (block?.type === "tool_use" && block.name && researchTools.includes(block.name)) researched = true;
      }
    },
    /** a `tool` activity frame: a finished cross-reference's claims are kept */
    recordActivity(activity: unknown) {
      const event = activity as { status?: string; crossref?: Crossref } | null;
      if (event?.status === "done" && event.crossref && Array.isArray(event.crossref.claims)) {
        researched = true;
        crossrefs.push(event.crossref);
      }
    },
    /** the pages a search or read returned (the chat's own or a subagent's) */
    recordPages(pages: readonly { url: string; title: string }[]) {
      if (pages.length) researched = true;
      for (const page of pages) {
        const key = sourceKey(page.url);
        if (!sources.has(key)) sources.set(key, { title: page.title || page.url, url: page.url });
      }
    },
    get researched() {
      return researched;
    },
    /**
     * After a turn that finished normally: a research turn in a chat with no
     * world yet starts one, reported as the turn's World Labs row. Never
     * throws; a failure to start is logged and the turn is left alone.
     */
    finish(question: string, answer: string) {
      if (!researched || !chatId) return;
      let worlds: WorldService | null;
      try {
        worlds = service();
        if (!worlds || worlds.hasWorld(chatId)) return;
        const result = worlds.startWorld(chatId, {
          topic: question,
          answer,
          claims: mergeCrossrefs(crossrefs).claims,
          sources: [...sources.values()],
        });
        if (result.status !== "started") return;
        const id = `world-${crypto.randomUUID()}`;
        onActivity({
          id,
          name: WORLD_TOOL_NAME,
          action: "world",
          query: subjectFrom(question) || "Research world",
          chatId,
          status: "running",
        });
        onActivity({ id, status: "done" });
      } catch (error) {
        console.warn("[worlds] could not start the chat's world:", error);
      }
    },
  };
}

export type WorldTurn = ReturnType<typeof createWorldTurn>;
