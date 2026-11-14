import { z } from "zod";

import { VaultPathError } from "@/server/vault/files";
import { FullPageError, saveFullPage } from "@/server/vault/full-page";
import { readPage, ReadError } from "@/server/telem/read";

/**
 * POST /api/vault/full-page — References' "Save to vault": the page a source
 * note names, read through Telem (the same cached read "Read full page"
 * showed), appended to the note under a managed "Full page" section. The text
 * is read here, on the server — the client only names the note and the page.
 *
 * Request:  { path: "Sources/Foo.md", url: "https://…" }
 * Response: 200 { path } · 400 bad request or path · 403 cross-site / private
 *           target · 404 no such note · 409 the note names another page ·
 *           502 Telem couldn't read the page
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({ path: z.string().min(1).max(500), url: z.string().min(1).max(4000) });

export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  try {
    const page = await readPage(parsed.data.url);
    return Response.json(await saveFullPage(parsed.data.path, page));
  } catch (error) {
    if (error instanceof ReadError || error instanceof FullPageError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof VaultPathError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
