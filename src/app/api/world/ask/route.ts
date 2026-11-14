// Ported from nyc-world by menonsprithvi-web (server.mjs @ a4e4a44, POST /api/ask).

import { query } from "@anthropic-ai/claude-agent-sdk";

import { telemKey, worldLineage } from "@/server/worlds/telem";

import { MAX_PAGES, MAX_PAGE_CHARS, buildPrompt, systemPrompt, type Page, type Turn } from "./prompt";
import { WORLD_TELEM_SERVER, WORLD_TELEM_TOOL_IDS, createWorldTelemServer } from "./tools";

/**
 * POST /api/world/ask — the chat panel inside a World Labs world: Claude
 * answers from the six screens floating around the viewer, citing them [n],
 * and may change them by ending its reply with one fenced ```actions block
 * (open a URL or a paper on a screen, highlight a phrase, swap all six to a
 * topic), which the viewer carries out. Its research tools are Telem's
 * (./tools.ts): telem_search (focus: general / official / research / news)
 * and telem_fetch, each call streamed to the viewer as a `trace` event; with no
 * TELEM_API_KEY it falls back to the SDK's web search.
 *
 * Like /api/chat it runs the Claude Agent SDK on this machine's own Claude
 * login: no API key is read or forwarded.
 *
 * Request:  { question: string, pages: {title, url, text}[], history?: {role, content}[], chatId?: string }
 * Response: text/event-stream of `delta` {text} and `trace` {tool, …}, then `done` {} or `error` {message}
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-opus-5-5";
/** answers about pages already in hand: medium effort keeps replies quick */
const EFFORT = "medium" as const;
export async function POST(request: Request) {
  let question: string;
  let pages: Page[];
  let history: Turn[];
  let chatId: unknown;
  try {
    const body = (await request.json()) as { question?: unknown; pages?: unknown; history?: unknown; chatId?: unknown };
    chatId = body.chatId;
    question = typeof body.question === "string" ? body.question.trim().slice(0, 4000) : "";
    pages = (Array.isArray(body.pages) ? body.pages : [])
      .filter((p): p is Page => !!p && typeof p === "object" && typeof (p as Page).text === "string")
      .slice(0, MAX_PAGES)
      .map((p) => ({
        title: typeof p.title === "string" ? p.title.slice(0, 300) : "",
        url: typeof p.url === "string" ? p.url.slice(0, 2000) : "",
        text: p.text.slice(0, MAX_PAGE_CHARS),
      }));
    history = (Array.isArray(body.history) ? body.history : []).filter(
      (t): t is Turn => (t?.role === "user" || t?.role === "assistant") && typeof t.content === "string",
    );
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!question || pages.length === 0) return Response.json({ error: "question and pages are required" }, { status: 400 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const telem = !!telemKey();
      // one Telem session per chat: the world's calls join its chat's lineage
      const telemServer = telem
        ? createWorldTelemServer({ lineage: worldLineage(chatId, question), onTrace: (trace) => send("trace", trace), signal: abort.signal })
        : undefined;
      try {
        const run = query({
          prompt: buildPrompt({ question, pages, history }),
          options: {
            model: MODEL,
            effort: EFFORT,
            thinking: { type: "adaptive" },
            systemPrompt: systemPrompt(telem),
            // research tools are Telem's (search + fetch), or web search without
            // a key; no built-in tools, no repo settings; a few turns allow
            // search → read → answer
            tools: telem ? [] : ["WebSearch"],
            ...(telemServer ? { mcpServers: { [WORLD_TELEM_SERVER]: telemServer } } : {}),
            allowedTools: telem ? WORLD_TELEM_TOOL_IDS : ["WebSearch"],
            settingSources: [],
            permissionMode: "dontAsk",
            maxTurns: 8,
            includePartialMessages: true,
            abortController: abort,
          },
        });
        /** text has gone out, and a new text block since (after a search) starts a paragraph */
        let sentText = false;
        let breakBeforeNext = false;
        for await (const message of run) {
          if (abort.signal.aborted) break;
          if (message.type === "stream_event") {
            const event = message.event;
            if (event.type === "content_block_start" && event.content_block.type === "text") {
              breakBeforeNext = sentText;
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
              send("delta", { text: (breakBeforeNext ? "\n\n" : "") + event.delta.text });
              sentText = true;
              breakBeforeNext = false;
            }
          } else if (message.type === "result" && message.subtype !== "success") {
            send("error", { message: `stopped: ${message.subtype}` });
            controller.close();
            return;
          }
        }
        send("done", {});
      } catch (error) {
        // a missing Claude login shows up here
        send("error", { message: error instanceof Error ? error.message : String(error) });
      }
      controller.close();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
