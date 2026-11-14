import { isFrequency, monitors } from "@/server/telem/monitors";
import { NO_STORE, isMonitorId, notConfigured, telemFailure } from "@/server/telem/respond";
import { endWatch } from "@/server/telem/watch";

/**
 * /api/telem/monitors/:id
 *   GET    — the monitor, its agent (status, plan, ticks, spend, budget,
 *            sources), its latest changes and events, the objects it found,
 *            its panels, its chat with you, and its recent jobs.
 *   PATCH  — { status?: "active" | "paused", frequency?: "1h"|"6h"|"12h"|"1d"|"7d" }
 *   DELETE — end the monitor (it stops running and billing); its findings stay.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/telem/monitors/[id]">;

export async function GET(_request: Request, ctx: Ctx) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  const client = monitors();
  try {
    const monitor = await client.get(id);
    const agent = monitor.agent_state ? await client.agent(id).catch(() => null) : null;
    const quiet = <T,>(promise: Promise<T>) => promise.catch(() => null);
    const watermark = monitor.agent_state?.watermark ?? 0;
    const [changes, events, objects, panels, chat, jobs] = agent
      ? await Promise.all([
          quiet(client.changes(id, { cursor: Math.max(0, watermark - 60), limit: 60 })),
          quiet(client.events(id, { limit: 60 })),
          quiet(client.objects(id, { limit: 100 })),
          quiet(client.panels(id)),
          quiet(client.chatMessages(id, 50)),
          quiet(client.jobs(id, { limit: 10 })),
        ])
      : [null, null, null, null, null, null];
    return Response.json(
      {
        monitor,
        agent,
        changes: changes?.changes ?? [],
        events: events?.events ?? [],
        objects: objects?.objects ?? [],
        objectsTotal: objects?.total ?? 0,
        panels: panels?.panels ?? [],
        chat: chat?.messages ?? [],
        jobs: jobs?.jobs ?? [],
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return telemFailure(error);
  }
}

export async function PATCH(request: Request, ctx: Ctx) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  let body: { status?: unknown; frequency?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const change: { status?: "active" | "paused"; frequency?: Parameters<ReturnType<typeof monitors>["update"]>[1]["frequency"] } = {};
  if (body.status === "active" || body.status === "paused") change.status = body.status;
  if (isFrequency(body.frequency)) change.frequency = body.frequency;
  if (!change.status && !change.frequency) {
    return Response.json({ error: "send status (active|paused) or frequency (1h|6h|12h|1d|7d)" }, { status: 400 });
  }
  try {
    return Response.json({ monitor: await monitors().update(id, change) }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const missing = notConfigured();
  if (missing) return missing;
  const { id } = await ctx.params;
  if (!isMonitorId(id)) return Response.json({ error: "no such monitor" }, { status: 404 });
  try {
    await endWatch(id);
    return Response.json({ deleted: true }, { headers: NO_STORE });
  } catch (error) {
    return telemFailure(error);
  }
}
