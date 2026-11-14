import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * POST /api/chat — one turn of Starline, streamed.
 *
 * Runs on the **Node** runtime, not the edge: the Claude Agent SDK drives the
 * local Claude Code binary as a subprocess, so it needs `child_process` and the
 * machine's own Claude login. There is deliberately **no API key anywhere** —
 * no `ANTHROPIC_API_KEY` is read, set, or forwarded. Credentials come from
 * whatever `claude` is already logged in as on this machine, which is why this
 * only works locally and why a deploy of this route would need rethinking.
 *
 * Request:  { messages: { role: "user" | "assistant", content: string }[] }
 * Response: text/event-stream of
 *             event: delta   data: {"text": "..."}
 *             event: done    data: {}
 *             event: error   data: {"message": "..."}
 *
 * The history is capped to the last 30 turns and replayed as a transcript in a
 * single prompt. The SDK's `query()` is a fresh session per call — it has no
 * memory of previous requests — so the conversation has to travel in the
 * prompt, the same way it would with the Messages API.
 */

export const runtime = "nodejs";
/** the request runs as long as the model does; never prerender this */
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-5";
const MAX_TURNS_OF_HISTORY = 30;
const SYSTEM_PROMPT =
  "You are Starline, an AI assistant. Be concise.";

type Turn = { role: "user" | "assistant"; content: string };

function isTurn(value: unknown): value is Turn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string"
  );
}

/**
 * Fold the history into one prompt. The last turn is the question; anything
 * before it is context, labelled so the model can tell the two speakers apart.
 */
function buildPrompt(turns: Turn[]): string {
  const recent = turns.slice(-MAX_TURNS_OF_HISTORY);
  const question = recent[recent.length - 1];
  const earlier = recent.slice(0, -1);
  if (earlier.length === 0) return question.content;

  const transcript = earlier
    .map((turn) => `${turn.role === "user" ? "User" : "Starline"}: ${turn.content}`)
    .join("\n\n");
  return `Here is the conversation so far:\n\n${transcript}\n\nUser: ${question.content}`;
}

export async function POST(request: Request) {
  let turns: Turn[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages.filter(isTurn) : [];
    if (messages.length === 0) {
      return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
    }
    turns = messages;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, event: string, data: unknown) =>
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  // Abort the model run when the client hangs up (the Stop button, or a reload
  // mid-answer). Without this the subprocess would keep generating into a
  // stream nobody is reading.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const run = query({
          prompt: buildPrompt(turns),
          options: {
            model: MODEL,
            systemPrompt: SYSTEM_PROMPT,
            // one turn, no tools, no filesystem settings: this is a chat reply,
            // not an agent. `tools: []` disables the built-ins; `settingSources:
            // []` keeps the repo's own CLAUDE.md and hooks out of it.
            tools: [],
            settingSources: [],
            maxTurns: 1,
            includePartialMessages: true,
            abortController: abort,
          },
        });

        for await (const message of run) {
          if (abort.signal.aborted) break;
          // Text arrives as Messages API streaming events wrapped in the SDK's
          // `stream_event` frame — not as a top-level delta message.
          if (message.type === "stream_event") {
            const event = message.event;
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta" &&
              event.delta.text
            ) {
              send(controller, "delta", { text: event.delta.text });
            }
          } else if (message.type === "result" && message.subtype !== "success") {
            send(controller, "error", { message: `Starline stopped: ${message.subtype}` });
            controller.close();
            return;
          }
        }

        send(controller, "done", {});
        controller.close();
      } catch (error) {
        // Surface the real reason — a missing Claude login shows up here, and
        // silently swapping in an API key would hide exactly the thing worth
        // knowing about.
        send(controller, "error", {
          message: error instanceof Error ? error.message : String(error),
        });
        controller.close();
      }
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
