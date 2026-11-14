import { describe, expect, it, vi } from "vitest";

import { assertPublicHost } from "@/app/api/embed-check/check";

import { fetchPage } from "./fetch-page";

/** GET /api/world/page's fetch: public http(s) HTML only, every redirect hop guarded */

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) } });

describe("world page fetch — SSRF guard", () => {
  it("refuses loopback, private and non-http targets without fetching", async () => {
    const fetch = vi.fn();
    for (const url of ["http://127.0.0.1/", "http://localhost:3500/api/chat", "http://10.0.0.5/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"]) {
      expect(await fetchPage(url, { fetch })).toMatchObject({ ok: false, status: 403 });
    }
    expect(await fetchPage("file:///etc/passwd", { fetch })).toMatchObject({ ok: false, status: 400 });
    expect(await fetchPage("not a url", { fetch })).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks every redirect hop: a public page redirecting to a private address is refused", async () => {
    const guard = vi.fn(async (host: string) => (host === "public.example" ? undefined : assertPublicHost(host)));
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin" } }));
    expect(await fetchPage("https://public.example/start", { fetch, guard })).toMatchObject({ ok: false, status: 403 });
    expect(guard).toHaveBeenLastCalledWith("192.168.1.1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a public page's HTML with its final URL, and refuses what is not a web page", async () => {
    const guard = async () => {};
    const ok = await fetchPage("https://public.example/a", {
      guard,
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/b" } }))
        .mockResolvedValueOnce(html("<h1>B</h1>")),
    });
    expect(ok).toEqual({ ok: true, html: "<h1>B</h1>", finalUrl: "https://public.example/b" });

    const pdf = await fetchPage("https://public.example/a.pdf", {
      guard,
      fetch: vi.fn(async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } })),
    });
    expect(pdf).toMatchObject({ ok: false, status: 415 });
  });
});
