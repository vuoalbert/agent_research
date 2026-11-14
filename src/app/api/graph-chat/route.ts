import { askClaude, buildPrompt, parseRequest, resolveAnswer } from "./navigate";

/**
 * POST /api/graph-chat — the Force graph chatbox: where in the graph a
 * question points.
 *
 * Node runtime (the Claude Agent SDK drives the local `claude` binary, on the
 * machine's own Claude login — no API key), never prerendered.
 *
 * Request:  { question: string,
 *             graph: { nodes: { id, kind: "chat"|"subagent"|"search"|"page", label, degree }[],
 *                      links: { source, target, kind }[] } }
 *           capped at 600 nodes / 2000 links, labels cut to 120 chars
 * Response: 200 { reply: string, focus: string | null, highlight: string[] }
 *           — ids are the request's own; unknown ones are dropped
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
  const { prompt, aliases } = buildPrompt(parsed.value);
  try {
    const raw = await askClaude(prompt, request.signal);
    return Response.json(resolveAnswer(raw, aliases));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
