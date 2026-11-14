/**
 * Runs once when the Next server starts: begin recording Telem usage
 * (src/server/telem/usage.ts) before any route can make a Telem call, so a
 * call from a route that never imports the recorder is still kept.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startUsageRecorder } = await import("@/server/telem/usage");
  startUsageRecorder();
}
