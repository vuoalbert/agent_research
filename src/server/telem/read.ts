import { assertPublicHost, BlockedTargetError } from "@/app/api/embed-check/check";

import { createLineage, telemFetch, type TelemPage } from "./client";
import { platformOf } from "./platforms";

/**
 * readPage — one page, read through Telem for the app's reading views (the
 * Force graph's blocked pages, the Knowledge base preview, References' "Read
 * full page"). A platform link (YouTube, X, TikTok, LinkedIn, Maps…) is read
 * with that platform's providers pinned, falling back to Telem's default chain
 * if they decline it; any other page goes straight down the default chain.
 *
 * Same SSRF guard as /api/embed-check (http(s) only, public hosts only), even
 * though Telem is what connects: nothing local is ever sent out to be read.
 * Results live in memory for half an hour; failures are not kept. A `chatId`
 * files the read under that chat's Telem session (the shared client's
 * lineage), with caller "reader".
 */

export type ReadView = TelemPage & { host: string; platform?: string; chars: number };

export class ReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { expires: number; view: Promise<ReadView> }>();

const hostOf = (url: URL) => url.hostname.replace(/^www\./, "");

/** the URL, if it is one a reader may ask Telem for; throws ReadError otherwise */
export async function guardUrl(raw: string | null | undefined): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new ReadError("Not a valid URL", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ReadError("Only http and https pages can be read", 400);
  try {
    await assertPublicHost(url.hostname);
  } catch (error) {
    if (error instanceof BlockedTargetError) throw new ReadError(error.message, 403);
    throw new ReadError("The site could not be reached", 502);
  }
  url.hash = "";
  return url;
}

async function readUncached(url: URL, chatId?: string): Promise<ReadView> {
  const platform = platformOf(url.href);
  const lineage = createLineage({ chatId, question: `Read ${url.href}` });
  const attempt = async (providers?: string[]) => {
    try {
      const { pages, failed } = await telemFetch([url.href], {
        lineage,
        caller: "reader",
        goal: "Show the page in the app's reading view",
        ...(providers ? { providers } : {}),
      });
      return pages[0] ?? new ReadError(failed[0]?.error ?? "Telem could not read this page", 502);
    } catch (error) {
      return new ReadError(error instanceof Error ? error.message : String(error), 502);
    }
  };
  let page = await attempt(platform?.providers ?? undefined);
  /* a pinned platform chain that declines the link: let the default chain try */
  if (page instanceof ReadError && platform?.providers) page = await attempt();
  if (page instanceof ReadError) throw page;
  return {
    ...page,
    url: page.url || url.href,
    host: hostOf(url),
    ...(platform ? { platform: platform.name } : {}),
    chars: page.text.length,
  };
}

/** the page through Telem, cached per URL for half an hour */
export async function readPage(raw: string | null | undefined, { chatId }: { chatId?: string } = {}): Promise<ReadView> {
  const url = await guardUrl(raw);
  const key = url.href;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.view;
  const view = readUncached(url, chatId);
  cache.set(key, { expires: now + TTL_MS, view });
  view.catch(() => {
    if (cache.get(key)?.view === view) cache.delete(key);
  });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return view;
}

/** test-only */
export function __clearReadCache() {
  cache.clear();
}
