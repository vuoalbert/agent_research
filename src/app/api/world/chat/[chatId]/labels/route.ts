import { parseLabels } from "@/lib/worlds";
import { getWorldService } from "@/server/worlds/service";

/**
 * PUT /api/world/chat/:chatId/labels — `{ labels }`: the world's floating
 * labels after the viewer's edits (T adds one in front of you, U undoes the
 * last). Stored on the chat's world record; 404 if the chat has no world.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, ctx: RouteContext<"/api/world/chat/[chatId]/labels">) {
  const { chatId } = await ctx.params;
  let labels;
  try {
    labels = parseLabels(((await request.json()) as { labels?: unknown }).labels);
  } catch {
    labels = null;
  }
  if (!labels) return Response.json({ error: "labels must be an array of labels" }, { status: 400 });
  const world = getWorldService()?.setLabels(chatId, labels) ?? null;
  if (!world) return Response.json({ error: "no such world" }, { status: 404 });
  return Response.json({ world });
}
