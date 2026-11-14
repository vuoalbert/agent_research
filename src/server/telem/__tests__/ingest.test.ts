import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findingOf, ingestMonitor } from "../ingest";
import { readChatWatch, unseen, updateChatWatch } from "../store";

import { MONITOR_ID, fakeTelem } from "./fake";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `telem-${name}-`));

const CHANGES = [
  { seq: 1, kind: "plan_changed", subject: { entity_id: null, name: null }, before: null, after: { version: 1 }, at: "2026-11-14T10:00:00Z" },
  { seq: 2, kind: "entity_added", subject: { entity_id: "e1", name: "QuantumScape Cobra line" }, before: null, after: { status: "candidate" }, at: "2026-11-14T11:00:00Z" },
  { seq: 3, kind: "value_changed", subject: { entity_id: "e1", name: "QuantumScape Cobra line" }, before: "pilot", after: { value: "production", url: "https://example.com/qs-production" }, at: "2026-11-14T11:00:00Z" },
  { seq: 4, kind: "run", subject: { entity_id: null, name: null }, before: null, after: { tick: 1 }, at: "2026-11-14T11:01:00Z" },
];

describe("ingesting a monitor's changes", () => {
  it("keeps findings, not runs or plan changes", () => {
    const urls = new Map([["quantumscape cobra line", "https://example.com/qs"]]);
    const now = "2026-11-14T12:00:00Z";
    expect(findingOf(CHANGES[0], MONITOR_ID, urls, now)).toBeNull();
    expect(findingOf(CHANGES[3], MONITOR_ID, urls, now)).toBeNull();
    expect(findingOf(CHANGES[1], MONITOR_ID, urls, now)).toMatchObject({ name: "QuantumScape Cobra line", url: "https://example.com/qs", detail: "Found QuantumScape Cobra line" });
    expect(findingOf(CHANGES[2], MONITOR_ID, urls, now)).toMatchObject({ url: "https://example.com/qs-production", detail: "QuantumScape Cobra line: pilot → production" });
  });

  it("reads on from the cursor, records sources and findings once, and logs them in the vault", async () => {
    const dir = temp("store");
    const vault = temp("vault");
    const { client, calls } = fakeTelem({
      [`GET /v1/monitors/${MONITOR_ID}/agent/changes`]: (_b: unknown, url: URL) =>
        url.searchParams.get("cursor") === "0" ? { changes: CHANGES, next_cursor: 4, watermark: 4 } : { changes: [], next_cursor: 4, watermark: 4 },
      [`GET /v1/monitors/${MONITOR_ID}/agent/objects`]: {
        total: 1,
        objects: [{ identity_key: "k1", name: "QuantumScape Cobra line", status: "qualified", urls: ["https://example.com/qs"] }],
      },
    });
    const monitor = { id: MONITOR_ID, query: "Solid-state battery production", frequency: "1d", auto: true, createdAt: "", cursor: 0 };
    await updateChatWatch("chat-1", (w) => void w.monitors.push(monitor), dir);

    const first = await ingestMonitor("chat-1", monitor, { client, dir, vaultRoot: vault, now: () => "2026-11-14T12:00:00Z" });
    expect(first.cursor).toBe(4);
    expect(first.findings.map((f) => f.seq)).toEqual([2, 3]);
    expect(first.sources.map((s) => s.url)).toEqual(["https://example.com/qs", "https://example.com/qs-production"]);

    const watch = await readChatWatch("chat-1", dir);
    expect(watch.monitors[0].cursor).toBe(4);
    expect(unseen(watch).sources).toHaveLength(2);

    // the second pass starts from the stored cursor and finds nothing twice
    const again = await ingestMonitor("chat-1", watch.monitors[0], { client, dir, vaultRoot: vault });
    expect(again.findings).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith("/changes")).map((c) => c.search)).toEqual(["?cursor=0", "?cursor=4"]);

    // the vault: a Watch log and a Source note per page, linked
    const log = readFileSync(join(vault, "Watch", "Solid-state battery production.md"), "utf8");
    expect(log).toContain("type: watch");
    expect(log).toContain("2026-11-14 · Found QuantumScape Cobra line — [[");
    const sources = readdirSync(join(vault, "Sources"));
    expect(sources).toHaveLength(2);
    expect(readFileSync(join(vault, "Sources", sources[0]), "utf8")).toContain("[[Solid-state battery production]]");
  });
});
