import type { NextRequest } from "next/server";

import { resolveWikilink } from "@/lib/vault-browse";
import { vaultTree } from "@/server/vault/browse";

/**
 * GET /api/vault/resolve?title=Foo — the path a `[[Foo]]` link names
 * (`Foo|alias`, `Foo#Heading` and `Folder/Foo.md` work too), matched
 * case-insensitively by file name: `{ path }`, or 404. The panel resolves
 * links from the tree's `titles` map; this is the one-off form.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const title = request.nextUrl.searchParams.get("title");
  if (!title?.trim()) return Response.json({ error: "title is required" }, { status: 400 });
  const path = resolveWikilink(title, (await vaultTree()).titles);
  if (!path) return Response.json({ error: "no such note" }, { status: 404 });
  return Response.json({ path });
}
