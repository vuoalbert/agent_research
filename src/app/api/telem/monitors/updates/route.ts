import { telemConfigured } from "@/server/telem/monitors";
import { NO_STORE } from "@/server/telem/respond";
import { readChatWatch, unseen, updateChatWatch } from "@/server/telem/store";
import { ensurePoller } from "@/server/telem/watch";

/**
 * /api/telem/monitors/updates?chat=<chatId> — what a chat's watch has brought
 * in, from the server-side record (no Telem call): the monitors it watches,
 * the sources its findings came from (the Knowledge base merges them), its
 * latest findings, and which of them are new since the chat last looked.
 *   GET  → { configured, monitors, sources, findings, fresh: { sources: url[], findings: boolean } }
 *   POST → marks everything so far as seen.
 * Asking starts the background reads (ensurePoller) if they are not running.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const chatOf = (request: Request) => {
  const chat = new URL(request.url).searchParams.get("chat")?.trim();
  return chat && chat.length <= 200 ? chat : null;
};

export async function GET(request: Request) {
  const chatId = chatOf(request);
  if (!chatId) return Response.json({ error: "chat is required" }, { status: 400 });
  const configured = telemConfigured();
  if (configured) ensurePoller();
  const watch = await readChatWatch(chatId);
  const fresh = unseen(watch);
  return Response.json(
    {
      configured,
      monitors: watch.monitors.map(({ id, query, frequency, auto, deleted, lastIngestAt }) => ({
        id,
        query,
        frequency,
        auto,
        deleted: Boolean(deleted),
        lastIngestAt: lastIngestAt ?? null,
      })),
      sources: watch.sources.map(({ title, url, monitorId }) => ({ title, url, monitorId })),
      findings: watch.findings.slice(-40).reverse(),
      fresh: { sources: fresh.sources.map((s) => s.url), findings: fresh.findings.length > 0 },
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const chatId = chatOf(request);
  if (!chatId) return Response.json({ error: "chat is required" }, { status: 400 });
  await updateChatWatch(chatId, (watch) => {
    watch.seenAt = new Date().toISOString();
  });
  return Response.json({ seen: true }, { headers: NO_STORE });
}
