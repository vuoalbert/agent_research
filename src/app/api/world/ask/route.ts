// Ported from nyc-world by menonsprithvi-web (server.mjs, POST /api/ask).

import { query } from "@anthropic-ai/claude-agent-sdk";

import { MAX_PAGES, MAX_PAGE_CHARS, SYSTEM_PROMPT, buildPrompt, type Page, type Turn } from "./prompt";

/**
 * POST /api/world/ask — the chat panel inside a World Labs world: Claude
 * answers from the six screens floating around the viewer, citing them [n],
 * and may change them by ending its reply with one fenced ```actions block
 * (open a URL or a paper on a screen, highlight a phrase, swap all six to a
 * topic), which the viewer carries out. Web search is its one tool, to find
 * trustworthy pages to put on a screen.
 *
 * Like /api/chat it runs the Claude Agent SDK on this machine's own Claude
 * login: no API key is read or forwarded.
 *
 * Request:  { question: string, pages: {title, url, text}[], history?: {role, content}[] }
 * Response: text/event-stream of `delta` {text}, then `done` {} or `error` {message}
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
  try {
    const body = (await request.json()) as { question?: unknown; pages?: unknown; history?: unknown };
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
      try {
        const run = query({
          prompt: buildPrompt({ question, pages, history }),
          options: {
            model: MODEL,
            effort: EFFORT,
            thinking: { type: "adaptive" },
            systemPrompt: SYSTEM_PROMPT,
            // web search is the only tool (to find trustworthy sources); no repo
            // settings; a few turns allow search → answer
            tools: ["WebSearch"],
            allowedTools: ["WebSearch"],
            settingSources: [],
            permissionMode: "dontAsk",
            maxTurns: 6,
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
