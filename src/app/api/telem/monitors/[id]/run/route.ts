import { monitors } from "@/server/telem/monitors";
import { NO_STORE, isMonitorId, notConfigured, telemFailure } from "@/server/telem/respond";
import { ingestSoon } from "@/server/telem/watch";

/** POST /api/telem/monitors/:id/run — run the monitor's agent once now; its finds are read in a few minutes */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: RouteContext<"/api/telem/monitors/[id]/run">) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  try {
    const { job_id } = await monitors().runNow(id);
    ingestSoon();
    return Response.json({ jobId: job_id }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
