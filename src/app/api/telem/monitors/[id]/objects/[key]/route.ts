import { monitors } from "@/server/telem/monitors";
import { NO_STORE, isMonitorId, notConfigured, telemFailure } from "@/server/telem/respond";

/** GET /api/telem/monitors/:id/objects/:key — one object: its values, verdicts, history and pages */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/telem/monitors/[id]/objects/[key]">) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id, key } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  try {
    return Response.json({ object: await monitors().object(id, decodeURIComponent(key)) }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
