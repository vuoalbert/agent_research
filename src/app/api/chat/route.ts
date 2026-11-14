import { query } from "@anthropic-ai/claude-agent-sdk";

import { createTurnRecorder } from "@/server/vault/turn";

import { CROSSREF_TOOL, createCrossReferenceTool, createResearchLog } from "./cross-reference";
import { parseSources } from "./sources";
import { EXTRACT_TOOL_ID, TAVILY_SERVER, TAVILY_TOOL_ID, createTavilyServer, type Source } from "./tavily";
import { VAULT_TOOL_IDS, createVaultTools } from "./vault-tools";
import { VISUALIZE_PROMPT, VISUALIZE_SERVER, VISUALIZE_TOOL_ID, createVisualizeTurn } from "./visualize-tool";

const CROSSREF_TOOL_ID = `mcp__${TAVILY_SERVER}__${CROSSREF_TOOL}`;

/**
 * POST /api/chat — one turn of Agent Research, streamed.
 *
 * Runs on the **Node** runtime, not the edge: the Claude Agent SDK drives the
 * local Claude Code binary as a subprocess, so it needs `child_process` and the
 * machine's own Claude login. There is deliberately **no API key anywhere** —
 * no `ANTHROPIC_API_KEY` is read, set, or forwarded. Credentials come from
 * whatever `claude` is already logged in as on this machine, which is why this
 * only works locally and why a deploy of this route would need rethinking.
 *
 * Request:  { messages: { role: "user" | "assistant", content: string }[],
 *            sources?: { title: string, url: string }[],   (the chat's sources, for cross_reference)
 *            chatId?: string }                             (names the turn's Research note in the vault)
 * Response: text/event-stream of
 *             event: delta   data: {"text": "..."}
 *             event: tool    data: {"id","name":"Tavily","action"?:"read","query","status":"running"}
 *                            data: {"id","status":"done","sources":[{"title","url"}]}
 *                            data: {"id","status":"error","message"}
 *                            data: {"id","name":"Cross-reference","action":"crossref","query","status":"running"}
 *                              → {"id","status":"done","crossref":{"claims","relations"}}
 *                            data: {"id","name":"Vault","action":"vault","op":"search"|"read"|"write","query","status":"running"}
 *                            data: {"id","name":"Visualize","action":"visualize","query","jobId","status":"running"}
 *                                  (then "done" once the job is queued; see visualize-tool.ts —
 *                                  a research turn always ends with exactly one)
 *             event: done    data: {}
 *             event: error   data: {"message": "..."}
 *
 * The history is capped to the last 30 turns and replayed as a transcript in a
 * single prompt. The SDK's `query()` is a fresh session per call — it has no
 * memory of previous requests — so the conversation has to travel in the
 * prompt, the same way it would with the Messages API.
 *
 * A turn that researched (searched, read or cross-referenced) is written to the
 * vault once its stream has closed — see `src/server/vault/`.
 */

export const runtime = "nodejs";
/** the request runs as long as the model does; never prerender this */
export const dynamic = "force-dynamic";

/** Claude Opus 5.5 at high effort. Opus 5.5 defaults to `medium`, so it is set
 *  explicitly; its thinking is always on (adaptive) and cannot be disabled. */
const MODEL = "claude-opus-5-5";
const EFFORT = "high" as const;
const MAX_TURNS_OF_HISTORY = 30;
/** enough for a few searches, a couple of reads, and the answer after them */
const MAX_AGENT_TURNS = 16;
const SYSTEM_PROMPT = [
  "You are Agent Research, an AI assistant. Be concise.",
  "",
  "When a question needs current or external facts, research it:",
  "1. Search with tavily_search.",
  "2. Pick 2-4 independent sources, preferably primary or official ones, and read them with tavily_extract.",
  "3. Cross-reference the key facts (numbers, dates, names, claims) across at least two sources.",
  "4. Say where the sources agree, and flag any disagreement explicitly: which source says what.",
  "5. When sources conflict, prefer the primary or official one and say why.",
  "After gathering and reading sources for a factual question, call cross_reference once to check all sources against each other before writing.",
  "Report the agreements and conflicts its result shows.",
  "Cite inline by source name with a link, e.g. [Microsoft](https://news.microsoft.com/...).",
  "Do not mention how many sources you read or searches you ran.",
  "Keep the answer natural and to the point. Questions that don't need outside facts get a direct answer, no research.",
  "",
  "You have a research vault: Markdown notes kept from earlier research (Research answers, Sources, cross-referenced Claims).",
  "Before researching the web, call vault_search for the topic. If the vault already covers the question well and it is not time-sensitive,",
  "read the relevant notes with vault_read and answer from them. Cite each fact with its note and the note's original source link,",
  "e.g. [[Note title]] ([GamesRadar+](https://www.gamesradar.com/...)) — a Source note's url is in its frontmatter, a Research note lists its sources' urls;",
  "search the web only for what is missing or stale (check the notes' updated dates).",
  "When the user asks you to save or remember something, save it with vault_write.",
].join("\n");

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
    .map((turn) => `${turn.role === "user" ? "User" : "Agent Research"}: ${turn.content}`)
    .join("\n\n");
  return `Here is the conversation so far:\n\n${transcript}\n\nUser: ${question.content}`;
}

export async function POST(request: Request) {
  let turns: Turn[];
  let chatSources: Source[];
  let chatId: string | undefined;
  try {
    const body = (await request.json()) as { messages?: unknown; sources?: unknown; chatId?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages.filter(isTurn) : [];
    if (messages.length === 0) {
      return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
    }
    const sources = parseSources(body.sources);
    if (!sources) {
      return Response.json({ error: "sources must be an array of at most 60 http(s) sources" }, { status: 400 });
    }
    turns = messages;
    chatSources = sources;
    if (typeof body.chatId === "string" && body.chatId.length <= 200) chatId = body.chatId;
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
      // what this turn's research found, for the vault once the turn is over
      const turn = createTurnRecorder({ chatId, question: turns[turns.length - 1].content, knownSources: chatSources });
      let answer = "";
      const report = (activity: unknown) => {
        turn.recordActivity(activity);
        if (!abort.signal.aborted) send(controller, "tool", activity);
      };
      // the sources cross_reference checks: the chat's, then this request's finds
      const log = createResearchLog(chatSources);
      // every research turn ends with one figure (visualize-tool.ts)
      const visualize = createVisualizeTurn({
        onActivity: report,
        researchTools: [TAVILY_TOOL_ID, EXTRACT_TOOL_ID, CROSSREF_TOOL_ID],
        crossrefTool: CROSSREF_TOOL_ID,
      });
      try {
        const run = query({
          prompt: buildPrompt(turns),
          options: {
            model: MODEL,
            effort: EFFORT,
            thinking: { type: "adaptive" },
            systemPrompt: `${SYSTEM_PROMPT}\n\n${VISUALIZE_PROMPT}`,
            // No built-in tools and no filesystem settings: `tools: []` turns the
            // built-ins off and `settingSources: []` keeps the repo's CLAUDE.md
            // and hooks out. The tools are Tavily search and read, pre-approved;
            // `dontAsk` denies anything else rather than prompting.
            tools: [],
            settingSources: [],
            mcpServers: {
              [TAVILY_SERVER]: createTavilyServer(report, {
                onPages: (pages) => {
                  log.recordPages(pages);
                  turn.recordPages(pages);
                },
                tools: [
                  createCrossReferenceTool({ log, onActivity: report, signal: abort.signal }),
                  ...createVaultTools({ onActivity: report }),
                ],
              }),
              [VISUALIZE_SERVER]: visualize.server,
            },
            allowedTools: [TAVILY_TOOL_ID, EXTRACT_TOOL_ID, CROSSREF_TOOL_ID, ...VAULT_TOOL_IDS, VISUALIZE_TOOL_ID],
            permissionMode: "dontAsk",
            maxTurns: MAX_AGENT_TURNS,
            includePartialMessages: true,
            abortController: abort,
          },
        });

        /** text has gone out, and a new text block since should start a paragraph */
        let sentText = false;
        let breakBeforeNext = false;
        for await (const message of run) {
          if (abort.signal.aborted) break;
          visualize.observe(message);
          // Text arrives as Messages API streaming events wrapped in the SDK's
          // `stream_event` frame — not as a top-level delta message.
          if (message.type === "stream_event") {
            const event = message.event;
            if (event.type === "content_block_start" && event.content_block.type === "text") {
              // a reply split around a search ("Let me look." … the answer)
              // must not run its two halves together
              breakBeforeNext = sentText;
            } else if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta" &&
              event.delta.text
            ) {
              const chunk = (breakBeforeNext ? "\n\n" : "") + event.delta.text;
              answer += chunk;
              send(controller, "delta", { text: chunk });
              sentText = true;
              breakBeforeNext = false;
            }
          } else if (message.type === "result" && message.subtype !== "success") {
            send(controller, "error", { message: `Agent Research stopped: ${message.subtype}` });
            controller.close();
            return;
          }
        }

        // a research turn Claude did not visualize gets its figure queued here
        if (!abort.signal.aborted) visualize.finish(turns[turns.length - 1].content);
        send(controller, "done", {});
        controller.close();
        // after the stream: the reader never waits on the vault, and a failed
        // write is logged by the recorder, never surfaced
        if (!abort.signal.aborted) void turn.finish(answer);
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
