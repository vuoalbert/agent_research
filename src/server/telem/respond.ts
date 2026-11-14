import { TelemError, telemConfigured } from "./monitors";

/**
 * The Telem API routes' shared answers: a Telem error keeps its status and
 * code (a 429 stays a 429, so the client backs off), and an unconfigured app
 * says so instead of failing.
 */

export const NO_STORE = { "cache-control": "no-store" } as const;

export function telemFailure(error: unknown): Response {
  if (error instanceof TelemError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return Response.json({ error: error.message, code: error.code ?? null }, { status, headers: NO_STORE });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: NO_STORE });
}

export function notConfigured(): Response | null {
  return telemConfigured()
    ? null
    : Response.json({ error: "Telem is not configured (set TELEM_API_KEY)", configured: false }, { status: 503, headers: NO_STORE });
}

/** a monitor id is a UUID; anything else never reaches Telem */
export const isMonitorId = (id: string) => /^[0-9a-f-]{8,64}$/i.test(id);
