import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Can a page be shown in an <iframe> on this app? Answered from the page's
 * response headers only — `X-Frame-Options` and CSP `frame-ancestors` — so the
 * Force graph can show the live page or, when the site forbids embedding, a
 * card that opens it in a new tab. Nothing is stored but an in-memory verdict.
 *
 * SSRF guard: only http(s), and every hop's host must resolve to public
 * addresses — no loopback, private, link-local, unique-local or `localhost`.
 * The host is resolved here and again by `fetch` when it connects; the gap is
 * a rebinding window, but the response never leaves this module except as one
 * boolean and a reason, so a rebound request learns an attacker nothing.
 */

export type EmbedResult = { embeddable: boolean; reason?: string };
/** the HTTP status the route answers with, beside the verdict; `transient`
 *  marks a failure to reach the page, which is worth asking again soon */
export type EmbedVerdict = EmbedResult & { status: number; transient?: boolean };

export const TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 30 * 60 * 1000;
/** a failure to reach the page may be passing; ask again sooner */
const FAILURE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 500;
const USER_AGENT = "Mozilla/5.0 (compatible; AgentResearchEmbedCheck/1.0)";

/** ------------------------------------------------------------ addresses */

function v4Private([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"; 0.0.0.0 reaches the local host
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** eight 16-bit groups, or null; handles `::`, a zone id and a dotted tail */
function parseV6(ip: string): number[] | null {
  let text = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (!v4) return null;
    text = `${text.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const words = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return words.every((w) => !Number.isNaN(w)) ? words : null;
}

/** true for any address a server-side fetch must not reach */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]);
  if (kind === 4) {
    const v4 = parseV4(ip);
    return v4 ? v4Private(v4) : true;
  }
  if (kind !== 6) return true;
  const w = parseV6(ip);
  if (!w) return true;
  const embeddedV4 = [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff];
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (zeros(0, 5) && w[5] === 0xffff) return v4Private(embeddedV4); // ::ffff:a.b.c.d
  if (zeros(0, 6)) return v4Private(embeddedV4); // ::a.b.c.d (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return v4Private(embeddedV4); // NAT64
  return false;
}

export class BlockedTargetError extends Error {}

/** throws BlockedTargetError unless every address the host resolves to is public */
export async function assertPublicHost(hostname: string): Promise<void> {
  /* the brackets URL puts round an IPv6 literal, and a trailing root dot */
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    throw new BlockedTargetError("That address is not public");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedTargetError("That address is not public");
    return;
  }
  /* a lookup failure rejects as is: the page is unreachable, not forbidden */
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BlockedTargetError("That address is not public");
  }
}

/** -------------------------------------------------------------- headers */

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** does one CSP `frame-ancestors` source list let `embedder` frame `target`? */
export function frameAncestorsAllow(sources: string[], embedder: URL, target: URL): boolean {
  for (const raw of sources) {
    const source = raw.toLowerCase();
    if (source === "'none'") continue;
    if (source === "*") return true;
    if (source === "'self'") {
      if (embedder.origin === target.origin) return true;
      continue;
    }
    const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(source);
    if (scheme) {
      /* http: also lets an https embedder in */
      if (`${scheme[1]}:` === embedder.protocol || (scheme[1] === "http" && embedder.protocol === "https:")) return true;
      continue;
    }
    const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^:/]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(source);
    if (!host) continue;
    const [, sourceScheme, sourceHost, sourcePort] = host;
    if (sourceScheme && !(`${sourceScheme}:` === embedder.protocol || (sourceScheme === "http" && embedder.protocol === "https:"))) continue;
    if (!sourceScheme && embedder.protocol !== "http:" && embedder.protocol !== "https:") continue;
    const name = embedder.hostname.toLowerCase();
    const hostMatches =
      sourceHost === "*" ||
      (sourceHost.startsWith("*.") ? name.endsWith(sourceHost.slice(1)) : name === sourceHost);
    if (!hostMatches) continue;
    const port = embedder.port || DEFAULT_PORTS[embedder.protocol];
    const wanted = sourcePort ?? DEFAULT_PORTS[sourceScheme ? `${sourceScheme}:` : embedder.protocol];
    if (sourcePort === "*" || port === wanted) return true;
  }
  return false;
}

/**
 * Why a response may not be framed by `embedder`, or null if it may. An
 * enforced CSP `frame-ancestors` decides on its own (browsers then ignore
 * X-Frame-Options); without one, X-Frame-Options DENY/SAMEORIGIN blocks.
 */
export function frameBlockReason(headers: Headers, embedder: URL, target: URL): string | null {
  const csp = headers.get("content-security-policy");
  let ruled = false;
  if (csp) {
    /* several headers arrive comma-joined; each is enforced on its own */
    for (const policy of csp.split(",")) {
      for (const directive of policy.split(";")) {
        const [name, ...sources] = directive.trim().split(/\s+/);
        if (name?.toLowerCase() !== "frame-ancestors") continue;
        ruled = true;
        if (!frameAncestorsAllow(sources, embedder, target)) {
          return "The site's Content-Security-Policy (frame-ancestors) forbids embedding";
        }
      }
    }
  }
  if (ruled) return null;
  const xfo = headers.get("x-frame-options");
  if (xfo) {
    const values = xfo.split(",").map((v) => v.trim().toLowerCase());
    if (values.includes("deny")) return "The site's X-Frame-Options (DENY) forbids embedding";
    if (values.includes("sameorigin") && embedder.origin !== target.origin) {
      return "The site's X-Frame-Options (SAMEORIGIN) forbids embedding";
    }
  }
  return null;
}

/** ---------------------------------------------------------------- fetch */

async function request(url: URL, method: "HEAD" | "GET", signal: AbortSignal) {
  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal,
    headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
  });
  /* headers are all this needs; drop the body unread */
  void response.body?.cancel().catch(() => {});
  return response;
}

/** HEAD, or GET when the server will not answer HEAD properly */
async function headers(url: URL, signal: AbortSignal) {
  try {
    const head = await request(url, "HEAD", signal);
    if (head.status < 400) return head;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return request(url, "GET", signal);
}

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** the uncached check: parse, guard, follow up to three redirects, read the headers */
export async function checkEmbedUncached(rawUrl: string | null, embedderOrigin: string): Promise<EmbedVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl ?? "");
  } catch {
    return { status: 400, embeddable: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: 400, embeddable: false, reason: "Only http and https pages can be embedded" };
  }
  const embedder = new URL(embedderOrigin);
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url.hostname);
      const response = await headers(url, signal);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return { status: 200, embeddable: false, reason: "Too many redirects" };
        const next = new URL(location, url);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return { status: 200, embeddable: false, reason: "Redirects away from the web" };
        }
        url = next;
        continue;
      }
      if (response.status >= 400) {
        return { status: 200, embeddable: false, reason: `The site answered ${response.status}`, transient: true };
      }
      const blocked = frameBlockReason(response.headers, embedder, url);
      return blocked ? { status: 200, embeddable: false, reason: blocked } : { status: 200, embeddable: true };
    }
  } catch (error) {
    if (error instanceof BlockedTargetError) return { status: 403, embeddable: false, reason: error.message };
    if (isTimeout(error)) return { status: 200, embeddable: false, reason: "The site took too long to answer", transient: true };
    return { status: 200, embeddable: false, reason: "The site could not be reached", transient: true };
  }
}

/** ---------------------------------------------------------------- cache */

const cache = new Map<string, { expires: number; verdict: Promise<EmbedVerdict> }>();

/** cached per page and embedder for half an hour (failures for two minutes) */
export function checkEmbed(rawUrl: string | null, embedderOrigin: string): Promise<EmbedVerdict> {
  const key = `${embedderOrigin} ${rawUrl ?? ""}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.verdict;
  if (hit) cache.delete(key);
  const verdict = checkEmbedUncached(rawUrl, embedderOrigin);
  cache.set(key, { expires: now + CACHE_TTL_MS, verdict });
  void verdict.then((v) => {
    const entry = cache.get(key);
    if (entry?.verdict !== verdict) return;
    if (v.transient) entry.expires = Date.now() + FAILURE_TTL_MS;
  });
  /* oldest first: Map keeps insertion order */
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return verdict;
}

/** test-only */
export function __clearEmbedCache() {
  cache.clear();
}
