// @vitest-environment node
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTelemFakeFrom } from "@/test/telem-fake";

/**
 * deploy_subagents through POST /api/chat, the Agent SDK mocked and Telem faked:
 * a turn whose only research is its subagents' still counts as research —
 * their sources stream as tagged rows, cross_reference checks them, the vault
 * records them, and the turn gets its figure.
 */
type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<Result>;
type Server = { tools: { name: string; handler: Handler }[] };
type Args = { prompt: string; options: { systemPrompt: string; outputFormat?: unknown; mcpServers: Record<string, Server> } };

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));
const search = vi.fn();
const extract = vi.fn();
vi.mock("@tavily/core", () => ({ tavily: () => ({ search, extract }) }));

const KEY = Symbol.for("agent_research.visualize.runner");
type Holder = { [KEY]?: unknown };
const startJob = vi.fn();

const TOYOTA = "https://global.toyota/en/newsroom/solid-state";
const QS = "https://ir.quantumscape.com/news";
const SAMSUNG = "https://www.samsungsdi.com/ssb";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "route-subagents-"));
  vi.stubEnv("VAULT_DIR", dir);
  vi.stubEnv("TAVILY_API_KEY", "");
  installTelemFakeFrom({ search, extract });
  query.mockReset();
  search.mockReset();
  extract.mockReset();
  startJob.mockReset();
  startJob.mockImplementation((input: { subject: string }) => ({
    status: "started",
    job: { id: "job-1", subject: input.subject, status: "running", createdAt: 1 },
  }));
  (globalThis as Holder)[KEY] = { startJob };
});
afterEach(() => {
  delete (globalThis as Holder)[KEY];
});

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });

async function post(question: string) {
  const { POST } = await import("@/app/api/chat/route");
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ chatId: "chat-ssb", messages: [{ role: "user", content: question }] }),
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => ({ event: /^event: (.+)$/m.exec(frame)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null") }));
}

const SUBAGENT_PAGES: Record<string, { title: string; url: string; content: string }[]> = {
  Makers: [
    { title: "Toyota solid-state plan", url: TOYOTA, content: "Toyota plans to launch solid-state battery EVs in 2027-28. ".repeat(3) },
    { title: "Samsung SDI all-solid-state", url: SAMSUNG, content: "Samsung SDI targets mass production of solid-state cells in 2027. ".repeat(3) },
  ],
  Startups: [
    { title: "QuantumScape news", url: QS, content: "QuantumScape shipped B-sample cells and targets 2027 production. ".repeat(3) },
  ],
};

describe("POST /api/chat — subagents", () => {
  it("counts a subagents-only turn as research: tagged rows, cross_reference over their sources, vault notes, a figure", async () => {
    search.mockImplementation(async (q: string) => ({ results: SUBAGENT_PAGES[q.split(" ")[0]] ?? [] }));
    // a read returns the page's full text (and the cross-reference reads nothing new)
    const all = Object.values(SUBAGENT_PAGES).flat();
    extract.mockImplementation(async (urls: string[]) => ({
      results: all
        .filter((page) => urls.includes(page.url))
        .map((page) => ({ url: page.url, title: page.title, rawContent: `${page.content} Full text.` })),
      failedResults: [],
    }));
    let analysed = "";
    let deployReply = "";
    query.mockImplementation((args: Args) => {
      if (args.options.outputFormat) {
        // the cross-reference analysis: what it was given is what was checked
        analysed = args.prompt;
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "",
            structured_output: {
              claims: [
                {
                  id: "C1",
                  text: "Solid-state EV cells reach production around 2027.",
                  sources: [
                    { source: "S1", stance: "supports", quote: "2027-28" },
                    { source: "S2", stance: "supports", quote: "mass production of solid-state cells in 2027" },
                  ],
                },
              ],
            },
          };
        })();
      }
      if (args.options.systemPrompt.startsWith("You are a research subagent")) {
        // a subagent: one search on its angle, then its result
        const angle = /Your angle: (\w+)/.exec(args.prompt)![1];
        return (async function* () {
          const [searchTool, readTool] = args.options.mcpServers.research.tools;
          await searchTool.handler({ query: `${angle} solid-state 2026` });
          if (angle === "Startups") await readTool.handler({ urls: [QS] });
          yield { type: "result", subtype: "success", result: `Headline: ${angle} aim for 2027\nKey claims:\n- 2027 — ${SUBAGENT_PAGES[angle][0].url}` };
        })();
      }
      // the chat Claude: deploy, cross-reference, answer
      const research = args.options.mcpServers.research.tools;
      const call = (name: string, input: Record<string, unknown>) => research.find((t) => t.name === name)!.handler(input);
      return (async function* () {
        yield assistant({ type: "tool_use", id: "d1", name: "mcp__research__deploy_subagents", input: {} });
        deployReply = (
          await call("deploy_subagents", {
            subagents: [
              { title: "Makers", task: "Carmakers' and cell makers' solid-state timelines" },
              { title: "Startups", task: "Solid-state startups' progress" },
            ],
          })
        ).content[0].text;
        // the SDK hands the tool's reply back as a user turn
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "d1", content: [{ type: "text", text: deployReply }] }] } };
        await call("cross_reference", { topic: "solid-state batteries 2026" });
        yield delta("Production is targeted for around 2027 [Toyota](https://global.toyota/en/newsroom/solid-state).");
        yield { type: "result", subtype: "success", num_turns: 4, result: "" };
      })();
    });

    const frames = await post("What's the state of solid-state batteries for EVs in 2026?");
    const tools = frames.filter((f) => f.event === "tool").map((f) => f.data);

    // the group, and the subagents' own searches tagged into it
    const group = tools.filter((t) => t.action === "subagents");
    expect(group.at(-1)).toMatchObject({ status: "done", name: "Subagents" });
    const groupId = group[0].id;
    const own = tools.filter((t) => t.parentId === groupId && t.status === "running");
    expect(own.map((t) => t.query).sort()).toEqual(["Makers solid-state 2026", "Startups solid-state 2026", "ir.quantumscape.com"]);
    expect(group.at(-1).subagents.map((s: { line: string }) => s.line)).toEqual(["Makers aim for 2027", "Startups aim for 2027"]);
    expect(deployReply).toContain("Headline: Makers aim for 2027");

    // cross_reference saw every subagent's sources
    for (const url of [TOYOTA, SAMSUNG, QS]) expect(analysed).toContain(url);
    expect(tools.find((t) => t.crossref)?.crossref.claims).toHaveLength(1);

    // the visualize fallback counts deploy_subagents as research
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(startJob.mock.calls[0][0]).toMatchObject({ origin: "research", brief: expect.stringContaining("Sources: global.toyota, ir.quantumscape.com") });

    // and the vault recorder wrote the subagents' sources
    await vi.waitFor(async () => {
      expect(await readdir(path.join(dir, "Sources"))).toHaveLength(3);
    });
    const [note] = await readdir(path.join(dir, "Research"));
    const research = await readFile(path.join(dir, "Research", note), "utf8");
    expect(research).toContain("chat_id: chat-ssb");
  });

  it("tells Claude to split research across subagents, and not for simple questions", async () => {
    query.mockImplementation(() =>
      (async function* () {
        yield delta("x");
      })(),
    );
    await post("hi");
    const { systemPrompt, allowedTools } = query.mock.calls[0][0].options;
    expect(systemPrompt).toMatch(/3-4 complementary angles/);
    expect(systemPrompt).toMatch(/call deploy_subagents once/);
    expect(systemPrompt).toMatch(/Compare their findings/);
    expect(systemPrompt).toMatch(/no research and no subagents/);
    expect(allowedTools).toContain("mcp__research__deploy_subagents");
  });
});
