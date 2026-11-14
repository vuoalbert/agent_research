/**
 * The key two URLs share when they are the same page: no scheme, no `www.`,
 * lower-case host, no trailing slash, no fragment. Search and read often name
 * one page both ways (`https://www.x.com/a/` vs `http://x.com/a`).
 *
 * A plain module (no "use client") so the chat route can share it with the store.
 */
export function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const port = u.port ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${port}${path}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/** a URL's host without `www.`, or the URL itself if it does not parse */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
