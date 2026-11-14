import { monitors } from "@/server/telem/monitors";
import { NO_STORE, isMonitorId, notConfigured, telemFailure } from "@/server/telem/respond";

/**
 * /api/telem/monitors/:id/chat — talking to the monitor's own agent.
 *   POST { message } → 202 { jobId }: the agent answers in a job;
 *   GET  → { messages, job }: the conversation, and the newest chat job (so
 *          the page knows whether an answer is still coming).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/telem/monitors/[id]/chat">;

export async function GET(_request: Request, ctx: Ctx) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  try {
    const client = monitors();
    const [chat, jobs] = await Promise.all([client.chatMessages(id, 50), client.jobs(id, { kind: "chat", limit: 1 })]);
    return Response.json({ messages: chat.messages ?? [], job: jobs.jobs?.[0] ?? null }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}

export async function POST(request: Request, ctx: Ctx) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  let message = "";
  try {
    const body = (await request.json()) as { message?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!message || message.length > 4000) return Response.json({ error: "message must be 1-4000 characters" }, { status: 400 });
  try {
    const sent = await monitors().chat(id, message);
    return Response.json({ jobId: sent.job_id, messageId: sent.message_id }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
