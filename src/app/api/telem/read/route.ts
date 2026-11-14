import type { NextRequest } from "next/server";

import { readPage, ReadError } from "@/server/telem/read";

/**
 * GET /api/telem/read?url=…[&chat=…] — one page as clean text, read through
 * Telem: `{ url, title, host, text, provider, platform?, truncated?, chars }`.
 * Behind the Force graph's reading view for sites that refuse an <iframe>, the
 * Knowledge base preview and References' "Read full page". Platform links
 * (YouTube, X, TikTok, LinkedIn, Maps…) are read with their platform's Telem
 * providers. Cached in memory for half an hour.
 *
 * 400 for a missing or non-http(s) URL, 403 for a private or local target (or
 * a cross-site caller), 502 when Telem cannot read the page.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }
  const params = request.nextUrl.searchParams;
  try {
    const view = await readPage(params.get("url"), { chatId: params.get("chat") ?? undefined });
    return Response.json(view, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ReadError) return Response.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
