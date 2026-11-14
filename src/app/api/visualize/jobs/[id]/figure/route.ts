import { readFile } from "node:fs/promises";

import { figureChrome } from "@/server/visualize/figure-chrome";
import { FIGURE_HEADERS } from "@/server/visualize/figure-headers";
import { isJobId } from "@/server/visualize/paths";
import { whiteFigure } from "@/server/visualize/white-figure";
import { getRunner } from "@/server/visualize/runner";

/**
 * GET /api/visualize/jobs/:id/figure — a finished job's page, for the
 * Visualize view's iframe.
 *
 * It serves exactly one file: the runner's copy of that job's figure.html.
 * The id must look like a job id the runner made, and nothing else from the
 * request names a path. The page is the agent's own HTML and script, so it is
 * served locked down, on top of the iframe's `sandbox="allow-scripts"`:
 *   - CSP `sandbox allow-scripts`: an opaque origin even when opened directly,
 *     so it can never read this app's cookies or storage;
 *   - `default-src 'none'` and `connect-src 'none'`: inline script and style
 *     and data:/blob: images only — no network at all, no way to send
 *     anything anywhere;
 *   - `nosniff`, `no-store`, no referrer.
 * The page is shown on plain white: `whiteFigure` pins the kit's paper tones
 * to #FFFFFF (an inline <style>, which the CSP allows), and `figureChrome`
 * adds the app's chrome: no frame, an Expand pill, grey hover with a tooltip
 * and a Parts panel (inline <style> and <script> only).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/visualize/jobs/[id]/figure">) {
  const { id } = await ctx.params;
  const file = isJobId(id) ? getRunner().figureFile(id) : null;
  if (!file) return new Response("No figure for this job.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  // served on plain white, whatever paper tone the figure was built with, frameless, with the parts chrome
  const html = figureChrome(whiteFigure(await readFile(file, "utf8")));
  return new Response(html, { headers: FIGURE_HEADERS });
}
