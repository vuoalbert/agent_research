import { monitors } from "@/server/telem/monitors";
import { NO_STORE, isMonitorId, notConfigured, telemFailure } from "@/server/telem/respond";

/** DELETE /api/telem/monitors/:id/panels/:panelId — remove one of the monitor's panels */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, ctx: RouteContext<"/api/telem/monitors/[id]/panels/[panelId]">) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id, panelId } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  try {
    await monitors().deletePanel(id, panelId);
    return Response.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
