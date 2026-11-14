import type { NextRequest } from "next/server";

import { readVaultNote } from "@/server/vault/browse";
import { VaultPathError } from "@/server/vault/files";

/**
 * GET /api/vault/note?path=Sources/Foo.md — one note, read-only:
 * `{ path, title, frontmatter, body }`, the managed-section markers removed
 * (their content kept). Only `.md` files inside the vault: 400 for a missing,
 * absolute, `~`, `..`, hidden or symlinked path; 404 when there is no note.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) return Response.json({ error: "path is required" }, { status: 400 });
  try {
    const note = await readVaultNote(path);
    if (!note) return Response.json({ error: "no such note" }, { status: 404 });
    return Response.json(note, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof VaultPathError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
