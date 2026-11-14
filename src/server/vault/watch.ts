import { hostOf, sourceKey } from "@/lib/source-key";

import { isoDate, scanVault, serialize, vaultDir } from "./files";
import { inlineQuote, link, openSession, relOf, upsert } from "./write";

/**
 * What a Telem monitor found, in the vault: one `Watch/<topic>.md` log note
 * per monitor (a dated line per finding, newest merged in, nothing dropped),
 * and a `Sources/` note per page a finding came from, linked back to the log —
 * the same Source notes research turns write, found by the same `sourceKey`,
 * so a page both found lands in one note.
 */

export type WatchLogEntry = { date: string; line: string; url?: string; title?: string };

export async function writeWatchFindings(
  {
    monitorId,
    topic,
    chatId,
    entries,
  }: { monitorId: string; topic: string; chatId?: string; entries: readonly WatchLogEntry[] },
  root = vaultDir(),
): Promise<{ log: string; sources: string[]; written: string[] } | null> {
  if (entries.length === 0) return null;
  return serialize(async () => {
    const today = isoDate();
    const session = openSession(await scanVault(root), root);
    const log = session.allocate("Watch", "watch", `telem:${monitorId}`, topic);
    const written: string[] = [];

    const pages = new Map<string, { url: string; title: string }>();
    for (const entry of entries) {
      if (entry.url && !pages.has(sourceKey(entry.url))) {
        pages.set(sourceKey(entry.url), { url: entry.url, title: entry.title || hostOf(entry.url) });
      }
    }
    const sourceNotes = new Map(
      [...pages].map(([key, page]) => [key, session.allocate("Sources", "source", key, page.title)] as const),
    );

    const lines = entries.map((entry) => {
      const note = entry.url ? sourceNotes.get(sourceKey(entry.url)) : undefined;
      return `- ${entry.date} · ${inlineQuote(entry.line, 240)}${note ? ` — ${link(note.title)}` : ""}`;
    });

    if (
      await upsert(log, {
        today,
        fields: { type: "watch", key: `telem:${monitorId}`, monitor_id: monitorId, chat_id: chatId },
        firstFields: { date: today },
        sections: {
          preamble: `# ${inlineQuote(topic, 200)}\n\nWhat the Telem monitor watching this topic found, newest last.`,
          sections: [{ heading: "Log", body: lines.join("\n") }],
        },
        policies: { Log: "list" },
      })
    ) {
      written.push(relOf(root, log.abs));
    }

    for (const [key, page] of pages) {
      const note = sourceNotes.get(key)!;
      if (
        await upsert(note, {
          today,
          fields: { type: "source", url: page.url, key, host: hostOf(page.url) },
          firstFields: { first_seen: today },
          sections: {
            preamble: [`# ${inlineQuote(page.title, 200)}`, page.url].join("\n\n"),
            sections: [{ heading: "Watch", body: `- ${link(log.title)}` }],
          },
          policies: { Watch: "list" },
        })
      ) {
        written.push(relOf(root, note.abs));
      }
    }

    return {
      log: relOf(root, log.abs),
      sources: [...sourceNotes.values()].map((note) => relOf(root, note.abs)),
      written,
    };
  });
}
