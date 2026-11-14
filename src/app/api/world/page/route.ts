import { fetchPage } from "./fetch-page";

/**
 * GET /api/world/page?url=… — a public web page's HTML for a World Labs
 * screen (see fetch-page.ts), with its final URL in `x-final-url`. The page
 * is never served as a page of this app: the viewer parses it, strips it to
 * its main text and shows it in a script-less sandboxed frame.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const result = await fetchPage(new URL(request.url).searchParams.get("url"));
  if (!result.ok) return new Response(result.message, { status: result.status, headers: { "content-type": "text/plain" } });
  return new Response(result.html, {
    headers: {
      // the bytes are data for the viewer's DOMParser; never render them here
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-final-url": result.finalUrl,
      "cache-control": "no-store",
    },
  });
}
