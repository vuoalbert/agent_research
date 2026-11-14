import { sourceKey } from "@/lib/source-key";
import { findMore } from "@/server/telem/find";

import { askClaude, buildPrompt, parseRequest, resolveAnswer } from "./navigate";

/**
 * POST /api/graph-chat — the Force graph chatbox: where in the graph a
 * question points, and — for "find more sources like this" / "search for X" —
 * new sources from a Telem search, to add off the node it was about.
 *
 * Node runtime (the Claude Agent SDK drives the local `claude` binary, on the
 * machine's own Claude login — no API key), never prerendered.
 *
 * Request:  { question: string,
 *             graph: { nodes: { id, kind: "chat"|"subagent"|"search"|"page", label, degree }[],
 *                      links: { source, target, kind }[] },
 *             focus?: string | null   — the node the camera is on ("this")
 *             chatId?: string         — files the Telem search under that chat's session }
 *           capped at 600 nodes / 2000 links, labels cut to 120 chars
 * Response: 200 { reply: string, focus: string | null, highlight: string[],
 *                 found?: { query, from: string | null, sources: { title, url, excerpt, provider }[] } }
 *           — ids are the request's own; unknown ones are dropped; `found`
 *           holds only pages the graph does not draw yet
 *           400 { error } for a malformed request, 502 { error } if the model fails
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (parsed.value.graph.nodes.length === 0) {
    return Response.json({ reply: "The graph is empty — research something first.", focus: null, highlight: [] });
  }
  const chatId =
    body && typeof body === "object" && typeof (body as { chatId?: unknown }).chatId === "string"
      ? ((body as { chatId: string }).chatId.slice(0, 200) || undefined)
      : undefined;
  const { prompt, aliases } = buildPrompt(parsed.value);
  let answer;
  try {
    answer = resolveAnswer(await askClaude(prompt, request.signal), aliases);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
  const { search, ...navigation } = answer;
  if (!search) return Response.json(navigation);

  /* "find more": a Telem search, minus the pages the graph already draws */
  const from = search.from ?? parsed.value.focus ?? null;
  const drawn = new Set(parsed.value.graph.nodes.map((node) => node.id));
  try {
    const found = await findMore(search.query, {
      chatId,
      caller: "graph-chat",
      isKnown: (url) => drawn.has(`page:${sourceKey(url)}`),
      signal: request.signal,
    });
    const count = found.sources.length;
    return Response.json({
      ...navigation,
      focus: from ?? navigation.focus,
      highlight: [],
      reply:
        count === 0
          ? `Telem found nothing new for “${found.query}”.`
          : `Found ${count} new ${count === 1 ? "source" : "sources"} for “${found.query}” with Telem.`,
      found: { query: found.query, from, sources: found.sources },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the Telem search failed";
    return Response.json({ ...navigation, reply: `Couldn't search: ${message}`, found: { query: search.query, from, sources: [] } });
  }
}
