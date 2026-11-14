import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { VaultPathError } from "@/server/vault/files";
import { readNote, searchVault } from "@/server/vault/search";

/**
 * The research vault, read-only, for the background Visualize agent: so the
 * figure can use facts earlier research saved. Two tools on their own
 * in-process server, `vault_search` and `vault_read`, the same lookups the
 * chat's tools make (src/app/api/chat/vault-tools.ts) minus the write and the
 * chat rows. They run in this server process, not in the agent's Bash
 * sandbox; the vault's own path checks (`resolveInVault`) keep `vault_read`
 * inside the vault, and nothing here writes.
 */

export const VISUALIZE_VAULT_SERVER = "vault";
export const VISUALIZE_VAULT_TOOLS = ["vault_search", "vault_read"] as const;
/** the names Claude Code knows them by, for `allowedTools` and the guard */
export const VISUALIZE_VAULT_TOOL_IDS: readonly string[] = VISUALIZE_VAULT_TOOLS.map(
  (name) => `mcp__${VISUALIZE_VAULT_SERVER}__${name}`,
);

/** a note's text is cut here: a figure needs its facts, not a whole long note */
const MAX_NOTE_CHARS = 20_000;

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

export async function vaultSearch(query: string, dir?: string) {
  try {
    const hits = await searchVault(query, dir);
    if (hits.length === 0) return text(`The vault has no notes on "${query}".`);
    const lines = hits.map(
      (hit, i) => `[${i + 1}] ${hit.title} (${hit.type}) — ${hit.path}${hit.url ? `\nurl: ${hit.url}` : ""}\n${hit.snippet}`,
    );
    return text(`Vault notes for "${query}" (open one with vault_read):\n\n${lines.join("\n\n")}`);
  } catch (error) {
    return text(`Vault search failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export async function vaultRead(note: string, dir?: string) {
  try {
    const found = await readNote(note, dir);
    if (!found) return text(`No vault note named "${note}". Search with vault_search first.`, true);
    const body = found.text.length > MAX_NOTE_CHARS ? `${found.text.slice(0, MAX_NOTE_CHARS)}\n…(cut)` : found.text;
    return text(`${found.path}\n\n${body}`);
  } catch (error) {
    if (error instanceof VaultPathError) return text(`Refused: ${error.message}.`, true);
    return text(`Vault read failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export function createVaultServer(dir?: string) {
  return createSdkMcpServer({
    name: VISUALIZE_VAULT_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "vault_search",
        "Search the app's research vault (read-only): Markdown notes earlier research saved — Research answers, Sources with excerpts, cross-referenced Claims. Returns the best-matching notes with a snippet.",
        { query: z.string().min(1).max(300).describe("The topic or fact to look for") },
        ({ query }) => vaultSearch(query, dir),
      ),
      tool(
        "vault_read",
        "Read one research-vault note (read-only), by its title or its path inside the vault (e.g. Research/My question.md).",
        { note: z.string().min(1).max(300).describe("The note's title or vault-relative path") },
        ({ note }) => vaultRead(note, dir),
      ),
    ],
  });
}
