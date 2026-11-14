import { monitors, telemConfigured } from "@/server/telem/monitors";
import { NO_STORE, telemFailure } from "@/server/telem/respond";
import { listChatWatches } from "@/server/telem/store";
import { ensurePoller, pollerStatus } from "@/server/telem/watch";

/**
 * GET /api/telem/monitors — every monitor of the key, newest first, each with
 * its agent's status, spend and budget, and the chat that watches it (when
 * this app made it). Reads only: GETs do not count toward Telem's limit.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!telemConfigured()) return Response.json({ configured: false, monitors: [] }, { headers: NO_STORE });
  ensurePoller();
  try {
    const client = monitors();
    const [{ monitors: list }, watches] = await Promise.all([client.list({ limit: 100 }), listChatWatches()]);
    const owners = new Map<string, { chatId: string; auto: boolean; lastIngestAt?: string }>();
    for (const watch of watches) {
      for (const m of watch.monitors) owners.set(m.id, { chatId: watch.chatId, auto: m.auto, lastIngestAt: m.lastIngestAt });
    }
    const rows = await Promise.all(
      list.map(async (monitor) => {
        const agent = monitor.agent_state ? await client.agent(monitor.id).catch(() => null) : null;
        const lastTick = agent?.ticks?.[0];
        return {
          ...monitor,
          chat: owners.get(monitor.id) ?? null,
          agent: agent
            ? {
                status: agent.status,
                spend_usd: agent.spend_usd ?? null,
                budget: agent.budget ?? null,
                next_tick_at: agent.next_tick_at ?? null,
                last_tick: lastTick ?? null,
                counts: agent.counts ?? null,
              }
            : null,
        };
      }),
    );
    return Response.json({ configured: true, monitors: rows, poller: pollerStatus() }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
