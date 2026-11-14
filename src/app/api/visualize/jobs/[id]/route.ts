import { isJobId } from "@/server/visualize/paths";
import { getRunner } from "@/server/visualize/runner";

/**
 * GET /api/visualize/jobs/:id — one job, with its latest progress lines
 * (`?lines=`, 0–200, default 50; the chat's tool row asks for 0).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/visualize/jobs/[id]">) {
  const { id } = await ctx.params;
  const asked = Number(new URL(request.url).searchParams.get("lines") ?? 50);
  const lines = Number.isFinite(asked) ? Math.min(200, Math.max(0, Math.floor(asked))) : 50;
  const job = isJobId(id) ? getRunner().getJob(id, lines) : null;
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  return Response.json({ job }, { headers: { "cache-control": "no-store" } });
}
