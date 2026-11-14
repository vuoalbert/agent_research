// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import { __clearEmbedCache, checkEmbed, frameBlockReason, isPrivateAddress } from "./check";
import { GET } from "./route";

const APP = "http://localhost:3511";
const fetchMock = vi.fn<typeof fetch>();

/** a response with these headers; status 200 unless given */
const reply = (headers: Record<string, string> = {}, status = 200) =>
  new Response(status >= 300 && status < 400 ? null : "<html></html>", { status, headers });

beforeEach(() => {
  __clearEmbedCache();
  fetchMock.mockReset();
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const check = (url: string) => checkEmbed(url, APP);

describe("embed check: headers", () => {
  it.each([
    [{ "x-frame-options": "DENY" }, false, /X-Frame-Options \(DENY\)/],
    [{ "x-frame-options": "sameorigin" }, false, /SAMEORIGIN/],
    [{ "x-frame-options": "SAMEORIGIN, SAMEORIGIN" }, false, /SAMEORIGIN/],
    [{ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }, false, /frame-ancestors/],
    [{ "content-security-policy": "frame-ancestors 'self'" }, false, /frame-ancestors/],
    [{ "content-security-policy": "frame-ancestors https://*.youtube.com" }, false, /frame-ancestors/],
    [{ "content-security-policy": "script-src 'self', frame-ancestors 'self'" }, false, /frame-ancestors/],
    [{}, true, undefined],
    [{ "content-security-policy": "default-src 'self'" }, true, undefined],
    [{ "content-security-policy": "frame-ancestors *" }, true, undefined],
    [{ "content-security-policy": "frame-ancestors http:" }, true, undefined],
    [{ "content-security-policy": "frame-ancestors http://localhost:3511" }, true, undefined],
    [{ "content-security-policy": "frame-ancestors localhost:*" }, true, undefined],
    // frame-ancestors decides on its own; X-Frame-Options is then ignored
    [{ "content-security-policy": "frame-ancestors *", "x-frame-options": "DENY" }, true, undefined],
    [{ "x-frame-options": "ALLOW-FROM https://a.com" }, true, undefined],
  ])("%j → embeddable %s", async (headers, embeddable, reason) => {
    fetchMock.mockResolvedValueOnce(reply(headers));
    const result = await check("https://example.com/");
    expect(result.embeddable).toBe(embeddable);
    if (reason) expect(result.reason).toMatch(reason);
    else expect(result.reason).toBeUndefined();
  });

  it("matches frame-ancestors host sources against the embedder's origin", () => {
    const target = new URL("https://site.com/");
    const blocked = (csp: string, embedder: string) =>
      frameBlockReason(new Headers({ "content-security-policy": csp }), new URL(embedder), target);
    expect(blocked("frame-ancestors https://*.app.dev", "https://x.app.dev")).toBeNull();
    expect(blocked("frame-ancestors https://*.app.dev", "https://app.dev")).not.toBeNull();
    expect(blocked("frame-ancestors https://app.dev", "http://app.dev")).not.toBeNull();
    expect(blocked("frame-ancestors https:", "http://localhost:3511")).not.toBeNull();
    expect(blocked("frame-ancestors localhost", "http://localhost:3511")).not.toBeNull();
  });

  it("asks with HEAD and drops to GET when HEAD is refused", async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 405)).mockResolvedValueOnce(reply({ "x-frame-options": "DENY" }));
    const result = await check("https://example.com/a");
    expect(result.embeddable).toBe(false);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows up to three redirects and judges the last page", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ location: "https://www.example.com/" }, 301))
      .mockResolvedValueOnce(reply({ location: "/home" }, 302))
      .mockResolvedValueOnce(reply({ "x-frame-options": "DENY" }));
    const result = await check("http://example.com/");
    expect(result.embeddable).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://example.com/",
      "https://www.example.com/",
      "https://www.example.com/home",
    ]);
  });

  it("gives up after three redirects", async () => {
    for (let i = 0; i < 5; i++) fetchMock.mockResolvedValueOnce(reply({ location: `https://example.com/${i}` }, 302));
    const result = await check("https://example.com/start");
    expect(result).toMatchObject({ embeddable: false, reason: "Too many redirects" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("is not embeddable when the site errors or cannot be reached, or takes too long", async () => {
    fetchMock.mockResolvedValue(reply({}, 404));
    expect(await check("https://example.com/missing")).toMatchObject({ embeddable: false, reason: "The site answered 404" });

    fetchMock.mockReset().mockRejectedValue(new TypeError("fetch failed"));
    expect(await check("https://example.com/down")).toMatchObject({ embeddable: false, reason: "The site could not be reached" });

    fetchMock.mockReset().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await check("https://example.com/slow")).toMatchObject({ embeddable: false, reason: "The site took too long to answer" });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("remembers a verdict, per page", async () => {
    fetchMock.mockImplementation(async () => reply());
    await check("https://example.com/1");
    await check("https://example.com/1");
    await check("https://example.com/2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("embed check: SSRF guard", () => {
  it.each([
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://2130706433/", // 127.0.0.1, spelled as one number
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
  ])("rejects %s without fetching it", async (url) => {
    const result = await check(url);
    expect(result).toMatchObject({ status: 403, embeddable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["192.168.0.10"],
    ["::1"],
    ["fc00::abcd"],
    ["fe80::1%en0"],
  ])("rejects a public-looking host that resolves to %s", async (address) => {
    dns.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]);
    const result = await check("https://rebind.example/");
    expect(result).toMatchObject({ status: 403, embeddable: false, reason: "That address is not public" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every redirect hop, too", async () => {
    fetchMock.mockResolvedValueOnce(reply({ location: "http://192.168.0.1/admin" }, 302));
    const result = await check("https://example.com/");
    expect(result).toMatchObject({ status: 403, embeddable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url", ""])(
    "refuses %j as input",
    async (url) => {
      expect(await check(url)).toMatchObject({ status: 400, embeddable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("classifies addresses", () => {
    for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:2800:220:1::1"]) expect(isPrivateAddress(ip)).toBe(false);
    for (const ip of ["127.0.0.1", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "ff02::1", "fe80::1"])
      expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe("GET /api/embed-check", () => {
  const request = (url: string | null, headers: Record<string, string> = {}) => {
    const target = new URL(`${APP}/api/embed-check`);
    if (url !== null) target.searchParams.set("url", url);
    /* NextRequest's nextUrl is all the handler reads beyond the headers */
    return Object.assign(new Request(target, { headers }), { nextUrl: target }) as unknown as Parameters<typeof GET>[0];
  };

  it("answers { embeddable } for a page that allows framing", async () => {
    fetchMock.mockResolvedValueOnce(reply());
    const response = await GET(request("https://example.com/"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embeddable: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers with a reason when it does not", async () => {
    fetchMock.mockResolvedValueOnce(reply({ "x-frame-options": "DENY" }));
    const body = await (await GET(request("https://x.com/"))).json();
    expect(body).toEqual({ embeddable: false, reason: expect.stringMatching(/DENY/) });
  });

  it("400s without a url, 403s a private target or a cross-site caller", async () => {
    expect((await GET(request(null))).status).toBe(400);
    expect((await GET(request("http://127.0.0.1:3500/"))).status).toBe(403);
    expect((await GET(request("https://example.com/", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
