import { vaultTree } from "@/server/vault/browse";

/**
 * GET /api/vault/tree — the vault's folders and notes for the References
 * panel: `{ children, titles, count }` (see `VaultTree`). Folders come first,
 * alphabetical, the user's own included; root-level notes after them.
 * `titles` maps each lower-cased note title to its path, so the panel can
 * resolve `[[links]]` without another request. A missing vault is an empty
 * tree, not an error.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tree = await vaultTree();
  return Response.json(tree, { headers: { "Cache-Control": "no-store" } });
}
