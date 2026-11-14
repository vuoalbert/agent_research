import { isJobId } from "@/server/visualize/paths";
import { getRunner } from "@/server/visualize/runner";

/**
 * POST /api/visualize/jobs/:id/stop — stop a running job (or take a queued
 * one off the queue). Answers once the job has settled, with its record.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: RouteContext<"/api/visualize/jobs/[id]/stop">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? await getRunner().stopJob(id) : null;
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  return Response.json({ job });
}
