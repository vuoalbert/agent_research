import { createWatch, deleteWatch, pollWatch } from "@/server/worlds/monitors";
import { telemKey } from "@/server/worlds/telem";

/**
 * Telem Monitors for a World Labs label ("watch this topic",
 * src/server/worlds/monitors.ts):
 *   POST   /api/world/watch {query} — an hourly monitor for 7 days → {id, status, frequency, expires_at}
 *   GET    /api/world/watch?id=…    — new trustworthy results since the last poll
 *   DELETE /api/world/watch?id=…    — stop watching
 * 503 without TELEM_API_KEY.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const failed = (error: unknown) =>
  Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });

function monitorId(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("id");
  return id && /^[\w-]{1,128}$/.test(id) ? id : null;
}

export async function POST(request: Request) {
  if (!telemKey()) return Response.json({ error: "TELEM_API_KEY is not set" }, { status: 503 });
  let query: unknown;
  try {
    ({ query } = (await request.json()) as { query?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!query || typeof query !== "string") return Response.json({ error: "query is required" }, { status: 400 });
  try {
    return Response.json(await createWatch(query), { headers: noStore });
  } catch (error) {
    return failed(error);
  }
}

export async function GET(request: Request) {
  if (!telemKey()) return Response.json({ error: "TELEM_API_KEY is not set" }, { status: 503 });
  const id = monitorId(request);
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    return Response.json(await pollWatch(id), { headers: noStore });
  } catch (error) {
    return failed(error);
  }
}

export async function DELETE(request: Request) {
  if (!telemKey()) return Response.json({ error: "TELEM_API_KEY is not set" }, { status: 503 });
  const id = monitorId(request);
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    await deleteWatch(id);
    return Response.json({ id, deleted: true }, { headers: noStore });
  } catch (error) {
    return failed(error);
  }
}
