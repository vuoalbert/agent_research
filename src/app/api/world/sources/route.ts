import { searchTrusted, telemKey } from "@/server/worlds/telem";

/**
 * GET /api/world/sources?q=… — a World Labs label's screens: Telem search,
 * auto-routed across engines, kept to trustworthy sources with their trust
 * badges (src/server/worlds/telem.ts). 503 without TELEM_API_KEY.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 300);
  if (!q) return Response.json({ error: "q is required" }, { status: 400 });
  if (!telemKey()) return Response.json({ error: "TELEM_API_KEY is not set" }, { status: 503 });
  try {
    return Response.json(await searchTrusted(q), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
