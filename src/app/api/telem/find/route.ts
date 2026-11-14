import { z } from "zod";

import { findMore, MAX_FOUND } from "@/server/telem/find";

/**
 * POST /api/telem/find — the Knowledge base's "Find more": a Telem search for
 * sources the chat does not have yet.
 *
 * Request:  { query: string, known?: string[] (the chat's source URLs), chatId?: string }
 * Response: 200 { query, sources: { title, url, excerpt, provider }[] } — at most 6, none already known
 *           400 { error } for a malformed request, 502 { error } if Telem fails
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  query: z.string().trim().min(1),
  known: z.array(z.string()).max(1000).optional(),
  chatId: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  const { query, known, chatId } = parsed.data;
  try {
    return Response.json(
      await findMore(query, { known, chatId, caller: "knowledge-base", limit: MAX_FOUND, signal: request.signal }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
