import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { GraphChatAnswer, GraphChatGraph } from "@/lib/graph-highlight";

/**
 * navigate — the Force graph chatbox's one model call: a question and the
 * graph in, the node to fly to and the nodes to keep bright out.
 *
 * Node ids are long (`search:<chat>:<message>:<call>`, `page:<url key>`), so
 * the model sees short aliases (n1, n2, …) instead and the answer is mapped
 * back; anything it names that is not in the graph is dropped.
 */

export const MAX_NODES = 600;
export const MAX_LINKS = 2000;
export const MAX_LABEL = 120;
export const MAX_QUESTION = 500;
const MAX_REPLY = 300;

const MODEL = "claude-opus-5-5";

const NODE_KINDS = ["chat", "subagent", "search", "page"] as const;
const LINK_KINDS = ["asked", "built-on", "found", "read", "cross-ref", "agrees", "conflicts"] as const;

const RequestSchema = z.object({
  question: z.string().trim().min(1),
  graph: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(NODE_KINDS),
        label: z.string(),
        degree: z.number().int().nonnegative(),
      }),
    ),
    links: z.array(z.object({ source: z.string(), target: z.string(), kind: z.enum(LINK_KINDS) })),
  }),
  /** the node the camera is on, which "this" in a question means */
  focus: z.string().nullish(),
});

export type GraphChatRequest = { question: string; graph: GraphChatGraph; focus?: string | null };

/** the request, capped (nodes, links, label and question lengths), or why it is not one */
export function parseRequest(body: unknown): { ok: true; value: GraphChatRequest } | { ok: false; error: string } {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: `invalid request: ${parsed.error.issues[0]?.path.join(".") || "body"}` };
  const { question, graph, focus } = parsed.data;
  const seen = new Set<string>();
  const nodes = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push({ ...node, label: node.label.trim().slice(0, MAX_LABEL) });
    if (nodes.length === MAX_NODES) break;
  }
  const links = graph.links.filter((l) => seen.has(l.source) && seen.has(l.target)).slice(0, MAX_LINKS);
  return {
    ok: true,
    value: {
      question: question.slice(0, MAX_QUESTION),
      graph: { nodes, links },
      focus: focus && seen.has(focus) ? focus : null,
    },
  };
}

const AnswerSchema = z.object({
  reply: z.string().describe("At most two short sentences answering the question."),
  focus: z.string().nullable().describe("The id (n…) of the one node to fly the camera to, or null."),
  highlight: z
    .array(z.string())
    .describe("Ids (n…) of the nodes to keep bright; every other node dims. Empty to dim nothing."),
  search: z
    .object({
      query: z.string().describe("A web search query (under 12 words) that finds new sources for the request."),
      from: z.string().nullable().describe("The id (n…) of the node the new sources hang off, or null for the chat."),
    })
    .nullable()
    .optional()
    .describe("Only when the user asks to find, search for or add more sources; otherwise null."),
});

/** draft-07 with no `$schema` key: the CLI rejects zod 4's default draft-2020-12 URI */
export function answerJsonSchema(): Record<string, unknown> {
  const { $schema: _uri, ...schema } = z.toJSONSchema(AnswerSchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

export const SYSTEM_PROMPT = [
  "You navigate a research graph for the user. Nodes are chats (conversations), subagents (research helpers a chat sent out on one angle each), searches (queries a chat or subagent ran) and pages (sources).",
  "Links: asked (chat → its first search or a subagent; subagent → its first search), built-on (search → next search), found (search → page it found),",
  "read (search or chat → page it opened), cross-ref (pages read together), agrees (pages supporting the same claim),",
  "conflicts (one page contradicts another).",
  "",
  "Pick the node(s) that answer the question:",
  "- To go to / show / open one thing: set focus to that node; leave highlight empty unless the user asks to isolate it.",
  "- For 'most connected', 'related to X', 'what supports/contradicts X' questions: use the degrees and the link kinds",
  "  (agrees, conflicts and cross-ref matter most) to choose a coherent related subgraph — the topic node plus its relevant",
  "  neighbours — never the whole graph. Set focus to its most central chat or search node (a page focus zooms in on that",
  "  one page and hides the rest).",
  "- Only return ids listed in the graph. If nothing matches, say so and return focus null and an empty highlight.",
  "- To find / search for / add more sources (\"find more like this\", \"search for X\", \"more on Y\"): set search.query to a",
  "  focused web search query built from the request and the labels of the node it is about, and search.from to that node",
  "  (\"this\" means the focused node, when one is given; otherwise the node the question names, else null). A web search",
  "  then runs and its results join the graph off that node. Set focus to search.from and leave highlight empty; the reply",
  "  says what you are searching for (\"Searching for …\"). Every other question: search null.",
  "Reply in at most two short sentences (under 30 words in all), naming nodes by their labels, never by id.",
].join("\n");

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** the prompt, with nodes aliased n1…; `aliases` maps each alias back to its id */
export function buildPrompt({ question, graph, focus }: GraphChatRequest) {
  const aliases = new Map<string, string>();
  const aliasOf = new Map<string, string>();
  graph.nodes.forEach((node, i) => {
    aliases.set(`n${i + 1}`, node.id);
    aliasOf.set(node.id, `n${i + 1}`);
  });
  const nodeLines = graph.nodes.map((n) => `${aliasOf.get(n.id)}\t${n.kind}\t${n.degree}\t${clean(n.label)}`);
  const linkLines = graph.links.map((l) => `${aliasOf.get(l.source)} ${l.kind} ${aliasOf.get(l.target)}`);
  const prompt = [
    `Graph: ${graph.nodes.length} nodes, ${graph.links.length} links.`,
    "",
    "Nodes (id, kind, degree, label):",
    ...nodeLines,
    "",
    "Links (source kind target):",
    ...linkLines,
    "",
    ...(focus && aliasOf.has(focus)
      ? [`Focused node: ${aliasOf.get(focus)} (${clean(graph.nodes.find((n) => n.id === focus)?.label ?? "")})`, ""]
      : []),
    `Question: ${clean(question)}`,
  ].join("\n");
  return { prompt, aliases };
}

/** a search the model asked for, in real ids: the query and the node its results hang off */
export type SearchIntent = { query: string; from: string | null };

/** the model's answer in real ids: unknown ids dropped, the focus kept bright */
export function resolveAnswer(
  raw: unknown,
  aliases: ReadonlyMap<string, string>,
): GraphChatAnswer & { search?: SearchIntent } {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) throw new Error("graph chat returned an unusable answer");
  const ids = new Set(aliases.values());
  /** an alias, or (leniently) a real id the model copied */
  const resolve = (ref: string) => {
    const key = ref.trim();
    return aliases.get(key) ?? aliases.get(key.toLowerCase()) ?? (ids.has(key) ? key : null);
  };
  const focus = parsed.data.focus === null ? null : resolve(parsed.data.focus);
  const highlight = [...new Set(parsed.data.highlight.map(resolve).filter((id): id is string => id !== null))];
  if (focus && highlight.length > 0 && !highlight.includes(focus)) highlight.unshift(focus);
  const answer = { reply: clean(parsed.data.reply).slice(0, MAX_REPLY), focus, highlight };
  const search = parsed.data.search;
  if (!search || !clean(search.query)) return answer;
  return {
    ...answer,
    search: { query: clean(search.query).slice(0, MAX_QUESTION), from: search.from === null ? null : resolve(search.from) },
  };
}

/** one structured, tool-less Claude call on the local Claude login */
export async function askClaude(prompt: string, signal?: AbortSignal): Promise<unknown> {
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  signal?.addEventListener("abort", () => abortController.abort());
  const run = query({
    prompt,
    options: {
      model: MODEL,
      effort: "low",
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: answerJsonSchema() },
      // the structured answer is a tool the turn ends on; one spare turn lets a
      // malformed first attempt be retried
      maxTurns: 2,
      abortController,
    },
  });
  for await (const message of run) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`graph chat stopped: ${message.subtype}`);
    return message.structured_output ?? JSON.parse(/\{[\s\S]*\}/.exec(message.result ?? "")?.[0] ?? "null");
  }
  throw new Error("graph chat returned no result");
}
