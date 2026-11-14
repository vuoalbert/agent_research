import { getRunner } from "@/server/visualize/runner";

/**
 * GET /api/visualize/current — the one visualization there is (see the
 * runner), with its latest progress lines (`?lines=`, 0–200, default 50), or
 * `{ job: null }` before the first. Node runtime: the runner reads the
 * studio's job folder from disk.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const asked = Number(new URL(request.url).searchParams.get("lines") ?? 50);
  const lines = Number.isFinite(asked) ? Math.min(200, Math.max(0, Math.floor(asked))) : 50;
  return Response.json({ job: getRunner().currentJob(lines) }, { headers: { "cache-control": "no-store" } });
}
