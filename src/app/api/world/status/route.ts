import { telemKey } from "@/server/worlds/telem";

/** GET /api/world/status — whether the World Labs screens can use Telem (a key is set) */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ telem: !!telemKey() }, { headers: { "cache-control": "no-store" } });
}
