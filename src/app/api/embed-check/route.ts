import type { NextRequest } from "next/server";

import { checkEmbed } from "./check";

/**
 * GET /api/embed-check?url=… — may this app show that page in an <iframe>?
 *
 * Answers `{ embeddable: boolean, reason?: string }` from the page's response
 * headers (X-Frame-Options, CSP frame-ancestors), fetched server-side with a
 * HEAD (GET when HEAD fails), a 5s budget and at most three redirects, each
 * hop held to public addresses. Verdicts are cached in memory only; nothing is
 * written anywhere. 400 for a missing or non-http(s) URL, 403 for a private or
 * local target.
 *
 * Node runtime: the SSRF guard resolves hostnames with `node:dns`.
 */

export const runtime = "nodejs";
/** a fresh answer per request (the in-memory cache sits behind it) */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  /* for this app's own pages only: a cross-site caller gets nothing */
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ embeddable: false, reason: "Cross-site requests are not allowed" }, { status: 403 });
  }
  const { status, embeddable, reason } = await checkEmbed(
    request.nextUrl.searchParams.get("url"),
    request.nextUrl.origin,
  );
  return Response.json(reason ? { embeddable, reason } : { embeddable }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
