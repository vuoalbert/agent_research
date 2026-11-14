import { planSearch, telemKey, worldLineage } from "@/server/worlds/telem";

/**
 * GET /api/world/sources?q=…&chat=… — a World Labs label's screens: a 4-step
 * Telem search plan (overview / official / research / news, each auto-routed),
 * merged and kept to trustworthy sources with their trust badges, plus the
 * per-step trace for the viewer's Search trace panel
 * (src/server/worlds/telem.ts). `chat` puts the calls in that chat's Telem
 * session. 503 without TELEM_API_KEY.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim().slice(0, 300);
  if (!q) return Response.json({ error: "q is required" }, { status: 400 });
  if (!telemKey()) return Response.json({ error: "TELEM_API_KEY is not set" }, { status: 503 });
  try {
    const result = await planSearch(q, undefined, { lineage: worldLineage(params.get("chat"), q), signal: request.signal });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
