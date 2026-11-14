import { allUsage, chatUsage } from "@/server/telem/usage";

/**
 * GET /api/telem/usage — what research has spent, from the usage recorder
 * (src/server/telem/usage.ts).
 *
 *   ?chat=<chatId>   one chat: Telem searches/fetches, providers, latency,
 *                    failures and fallbacks, Telem and Claude cost, jobs, and
 *                    the research tree (main → subagents) with Telem lineage
 *   ?scope=all       every chat: totals, by day (UTC) and by provider
 *
 * Node runtime: the recorder reads `/.telem/usage/*.jsonl` from disk.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("scope") === "all") {
    return Response.json({ scope: "all", usage: await allUsage() }, { headers: NO_STORE });
  }
  const chat = params.get("chat");
  if (!chat || chat.length > 200) {
    return Response.json({ error: "pass ?chat=<chatId> or ?scope=all" }, { status: 400 });
  }
  return Response.json({ scope: "chat", usage: await chatUsage(chat) }, { headers: NO_STORE });
}
