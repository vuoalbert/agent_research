import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { FOLDERS, VaultPathError } from "@/server/vault/files";
import { noteName, readNote, searchVault } from "@/server/vault/search";
import { writeSavedNote } from "@/server/vault/write";

import { TAVILY_SERVER, type Source } from "./tavily";

/**
 * The research vault as Claude tools, on the same `research` server as Tavily:
 * `vault_search` finds notes earlier research left, `vault_read` opens one,
 * `vault_write` saves one when the user asks. Each reports a `Vault` row to
 * the chat the way the Tavily tools report theirs.
 */

export const VAULT_SEARCH_TOOL = "vault_search";
export const VAULT_READ_TOOL = "vault_read";
export const VAULT_WRITE_TOOL = "vault_write";
export const VAULT_TOOL_IDS = [VAULT_SEARCH_TOOL, VAULT_READ_TOOL, VAULT_WRITE_TOOL].map(
  (name) => `mcp__${TAVILY_SERVER}__${name}`,
);

export type VaultOp = "search" | "read" | "write";

export type VaultActivity =
  | { id: string; name: "Vault"; action: "vault"; op: VaultOp; query: string; status: "running" }
  | { id: string; status: "done"; sources: Source[] }
  | { id: string; status: "error"; message: string };

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

export function createVaultTools({
  onActivity,
  dir,
}: {
  onActivity: (activity: VaultActivity) => void;
  /** the vault folder; `VAULT_DIR` / `<repo>/vault` when absent */
  dir?: string;
}) {
  /** run one call as a row: running → done (with the pages it stands for) or error */
  const run = async (op: VaultOp, query: string, body: () => Promise<{ reply: string; sources?: Source[]; isError?: boolean }>) => {
    const id = crypto.randomUUID();
    onActivity({ id, name: "Vault", action: "vault", op, query, status: "running" });
    try {
      const { reply, sources = [], isError } = await body();
      if (isError) onActivity({ id, status: "error", message: reply });
      else onActivity({ id, status: "done", sources });
      return text(reply, isError);
    } catch (error) {
      const message =
        error instanceof VaultPathError
          ? `Refused: ${error.message}.`
          : `Vault ${op} failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!(error instanceof VaultPathError)) console.warn(`[vault] ${message}`);
      onActivity({ id, status: "error", message });
      return text(message, true);
    }
  };

  return [
    tool(
      VAULT_SEARCH_TOOL,
      "Search the research vault: Markdown notes saved from earlier research (Research answers, Sources with " +
        "excerpts and quotes, cross-referenced Claims). Returns the best-matching notes with type, path, last " +
        "update and a snippet. Call it before searching the web.",
      { query: z.string().min(1).describe("The topic or question to look for") },
      async ({ query }) =>
        run("search", query, async () => {
          const hits = await searchVault(query, dir);
          if (hits.length === 0) return { reply: `The vault has no notes on "${query}".` };
          const lines = hits.map(
            (hit, i) =>
              `[${i + 1}] ${hit.title} (${hit.type}) — ${hit.path}` +
              `${hit.updated ? `\nupdated: ${hit.updated}` : ""}${hit.url ? `\nurl: ${hit.url}` : ""}\n${hit.snippet}`,
          );
          return {
            reply: `Vault notes for "${query}" (open one with vault_read by title or path):\n\n${lines.join("\n\n")}`,
          };
        }),
    ),
    tool(
      VAULT_READ_TOOL,
      "Read one vault note in full, by its title (as a [[wikilink]] names it) or its path inside the vault " +
        "(e.g. Research/My question.md).",
      { note: z.string().min(1).describe("The note's title or vault-relative path") },
      async ({ note }) =>
        // the row names the note, not the path Claude used to reach it
        run("read", noteName(note.split(/[/\\]/).pop() ?? note) || note, async () => {
          const found = await readNote(note, dir);
          if (!found) return { reply: `No vault note named "${note}". Search with vault_search first.`, isError: true };
          return { reply: `${found.path}\n\n${found.text}`, sources: found.sources };
        }),
    ),
    tool(
      VAULT_WRITE_TOOL,
      "Save a note to the research vault, only when the user asks to save or remember something. Writing to " +
        "an existing title in the same folder updates the part of that note you saved before; the user's own " +
        "edits are kept. Use Markdown and [[Note title]] links to other vault notes.",
      {
        title: z.string().min(1).max(200).describe("The note's title (its file name)"),
        folder: z.enum(FOLDERS).describe("Research, Sources, Claims, or Notes for anything else"),
        content: z.string().min(1).describe("The note's Markdown"),
      },
      async ({ title, folder, content }) =>
        run("write", title, async () => {
          const saved = await writeSavedNote({ title, folder, content }, dir);
          return { reply: `${saved.created ? "Saved" : "Updated"} [[${saved.title}]] at ${saved.rel}.` };
        }),
    ),
  ];
}
