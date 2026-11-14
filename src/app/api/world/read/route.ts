import { readWithTelem, worldLineage } from "@/server/worlds/telem";

/**
 * GET /api/world/read?url=…&chat=… — Telem Fetch for a World Labs screen whose
 * page our own reader (/api/world/page) cannot read: clean markdown, its trust
 * badge. Public hosts only (the app's SSRF guard). 503 without TELEM_API_KEY.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const url = params.get("url");
  const result = await readWithTelem(url, { lineage: worldLineage(params.get("chat")), signal: request.signal });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  const { ok: _ok, ...page } = result;
  return Response.json(page, { headers: { "cache-control": "no-store" } });
}
