// @vitest-environment node
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { installTelemFakeFrom } from "@/test/telem-fake";

/**
 * The route and the vault together, with the Agent SDK mocked and Telem faked: a
 * researched turn lands in the vault after the stream closes, and the vault
 * tools report `Vault` rows.
 */
const query = vi.fn();
type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Result>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));

const search = vi.fn();
const extract = vi.fn();
vi.mock("@tavily/core", () => ({ tavily: () => ({ search, extract }) }));

const handler = (name: string) => {
  const { options } = query.mock.calls.find((call) => !call[0].options.outputFormat)![0];
  return (options.mcpServers.research.tools as { name: string; handler: Handler }[]).find((t) => t.name === name)!.handler;
};

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
};

const readAll = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
};

const frames = (body: string) => [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));

const MOJANG = "https://www.minecraft.net/en-us/article/sales";
const WIKI = "https://en.wikipedia.org/wiki/Minecraft";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "route-vault-"));
  vi.stubEnv("VAULT_DIR", dir);
  vi.stubEnv("TAVILY_API_KEY", "");
  installTelemFakeFrom({ search, extract });
  query.mockReset();
  search.mockReset();
  extract.mockReset();
});

/** a turn that searches, reads, cross-references and answers */
function researchTurn(answer: string) {
  search.mockResolvedValue({
    results: [
      { title: "Minecraft: 300 million", url: MOJANG, content: "Minecraft has sold more than 300 million copies worldwide." },
      { title: "Minecraft - Wikipedia", url: WIKI, content: "Minecraft is the best-selling video game, over 300 million copies." },
    ],
  });
  extract.mockResolvedValue({
    results: [
      { url: MOJANG, title: "Minecraft: 300 million", rawContent: "Minecraft has sold more than 300 million copies. ".repeat(5) },
      { url: WIKI, title: "Minecraft - Wikipedia", rawContent: "Over 300 million copies have been sold. ".repeat(5) },
    ],
    failedResults: [],
  });
  const analysis = {
    claims: [
      {
        id: "C1",
        text: "Minecraft has sold over 300 million copies.",
        sources: [
          { source: "S1", stance: "supports", quote: "more than 300 million copies" },
          { source: "S2", stance: "supports", quote: "Over 300 million copies" },
        ],
      },
    ],
  };
  query.mockImplementation((args: { options: { outputFormat?: unknown } }) =>
    args.options.outputFormat
      ? (async function* () {
          yield { type: "result", subtype: "success", result: "", structured_output: analysis };
        })()
      : (async function* () {
          await handler("web_search")({ query: "minecraft copies sold" }, {});
          await handler("web_read")({ urls: [MOJANG, WIKI] }, {});
          await handler("cross_reference")({ topic: "Minecraft sales" }, {});
          yield delta(answer);
        })(),
  );
}

describe("POST /api/chat — vault", () => {
  it("tells Claude to check the vault before the web", async () => {
    query.mockReturnValue((async function* () { yield delta("x"); })());
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    const { systemPrompt } = query.mock.calls[0][0].options;
    expect(systemPrompt).toMatch(/before researching the web, call vault_search/i);
    expect(systemPrompt).toMatch(/\[\[Note title\]\]/);
    expect(systemPrompt).toMatch(/vault_write/);
  });

  it("writes a researched turn's Research, Sources and Claims notes after the stream", async () => {
    researchTurn("Over 300 million, per [Minecraft.net](https://www.minecraft.net/en-us/article/sales).");
    const body = await readAll(
      await post({ chatId: "chat-42", messages: [{ role: "user", content: "How many copies has Minecraft sold?" }] }),
    );
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);

    await vi.waitFor(async () => {
      expect(await readdir(path.join(dir, "Claims"))).toEqual(["Minecraft has sold over 300 million copies.md"]);
    });
    expect(await readdir(path.join(dir, "Research"))).toEqual(["How many copies has Minecraft sold.md"]);
    expect((await readdir(path.join(dir, "Sources"))).sort()).toEqual(["Minecraft - 300 million.md", "Minecraft - Wikipedia.md"]);
    const research = await readFile(path.join(dir, "Research/How many copies has Minecraft sold.md"), "utf8");
    expect(research).toContain("chat_id: chat-42");
    expect(research).toContain("Over 300 million, per [Minecraft.net]");
    expect(research).toContain("- [[Minecraft has sold over 300 million copies]]");
    const claim = await readFile(path.join(dir, "Claims/Minecraft has sold over 300 million copies.md"), "utf8");
    expect(claim).toContain('- [[Minecraft - Wikipedia]] — "Over 300 million copies"');
  });

  it("writes nothing for a turn without research", async () => {
    query.mockReturnValue((async function* () { yield delta("Hello!"); })());
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(dir)).toEqual([]);
  });

  it("streams Vault rows for search, read and write, and answers from the vault", async () => {
    // a first chat fills the vault
    researchTurn("Over 300 million.");
    await readAll(await post({ chatId: "c1", messages: [{ role: "user", content: "How many copies has Minecraft sold?" }] }));
    await vi.waitFor(async () => expect(await readdir(dir)).toContain("Claims"));

    // a new chat asks again: vault only, no web
    query.mockReset();
    search.mockReset();
    const replies: Result[] = [];
    query.mockImplementation(() =>
      (async function* () {
        replies.push(await handler("vault_search")({ query: "Minecraft copies sold" }, {}));
        replies.push(await handler("vault_read")({ note: "Research/How many copies has Minecraft sold.md" }, {}));
        replies.push(await handler("vault_read")({ note: "../../etc/passwd" }, {}));
        replies.push(await handler("vault_write")({ title: "Minecraft follow-ups", folder: "Notes", content: "Check 2025 sales." }, {}));
        yield delta("From the vault: over 300 million [[How many copies has Minecraft sold]].");
      })(),
    );
    const body = await readAll(await post({ chatId: "c2", messages: [{ role: "user", content: "Minecraft sales again?" }] }));

    expect(search).not.toHaveBeenCalled();
    const events = frames(body);
    const starts = events.filter((e) => e.status === "running");
    expect(starts.map(({ name, action, op, query: q }) => ({ name, action, op, query: q }))).toEqual([
      { name: "Vault", action: "vault", op: "search", query: "Minecraft copies sold" },
      { name: "Vault", action: "vault", op: "read", query: "How many copies has Minecraft sold" },
      { name: "Vault", action: "vault", op: "read", query: "passwd" },
      { name: "Vault", action: "vault", op: "write", query: "Minecraft follow-ups" },
    ]);
    // the read reports the pages the note stands for; the traversal is an error
    const ends = events.filter((e) => e.status !== "running");
    expect(ends[1].sources.map((s: { url: string }) => s.url)).toEqual([MOJANG, WIKI]);
    expect(ends[2].status).toBe("error");

    expect(replies[0].content[0].text).toContain("How many copies has Minecraft sold (research) — Research/How many copies has Minecraft sold.md");
    expect(replies[1].content[0].text).toContain("## Answer\nOver 300 million.");
    expect(replies[2].isError).toBe(true);
    expect(replies[2].content[0].text).toMatch(/Refused/);
    expect(replies[3].content[0].text).toBe("Saved [[Minecraft follow-ups]] at Notes/Minecraft follow-ups.md.");

    // a vault-only turn adds no Research note of its own
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(path.join(dir, "Research"))).toEqual(["How many copies has Minecraft sold.md"]);
  });
});
