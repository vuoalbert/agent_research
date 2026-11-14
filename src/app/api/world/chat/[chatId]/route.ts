import { getWorldService } from "@/server/worlds/service";

/**
 * GET /api/world/chat/:chatId — the chat's World Labs world, `{ world }`, or
 * `{ world: null }` when it has none (yet). The World Labs tab and the chat's
 * World Labs row poll it while the world is generating.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/world/chat/[chatId]">) {
  const { chatId } = await ctx.params;
  if (!chatId || chatId.length > 200) return Response.json({ error: "bad chat id" }, { status: 400 });
  const world = getWorldService()?.getWorld(chatId) ?? null;
  return Response.json({ world }, { headers: { "cache-control": "no-store" } });
}
