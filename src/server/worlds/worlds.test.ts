import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { arcPositions, buildLabels } from "./labels";
import { createMarbleClient, type GenerateInput, type MarbleClient, type MarbleOperation, type MarbleWorld } from "./marble";
import { createWorldService } from "./service";
import { createWorldStore } from "./store";

/**
 * The world service against a mocked World Labs API — nothing here reaches
 * api.worldlabs.ai, and nothing is generated or paid for.
 */

const SPZ = "https://cdn.example.test/w1/world_500k.spz";
const scene = vi.fn(async () => ({
  title: "Fjord Charging Plaza",
  prompt: "Standing in the middle of a rain-washed charging plaza beside a fjord, rows of chargers… Cinematic, photorealistic, sharp detail, crisp textures.",
  labels: [{ text: "88.9% of new cars electric", query: "electric vehicles in Norway", claim: 1 }],
}));
const claims = [
  {
    id: "c1",
    text: "88.9% of new cars sold in Norway in 2024 were electric",
    sources: [
      { url: "https://ofv.no/stats", stance: "supports" as const, quote: "88.9%" },
      { url: "https://www.reuters.com/ev", stance: "supports" as const, quote: "nearly 89%" },
    ],
  },
];
const sources = [
  { title: "OFV statistics", url: "https://ofv.no/stats" },
  { title: "Reuters on EVs", url: "https://www.reuters.com/ev" },
];

function rig({ refuse = false }: { refuse?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "worlds-test-"));
  const store = createWorldStore(dir);
  const timers: (() => void)[] = [];
  const marble = {
    generate: vi.fn(async (_input: GenerateInput): Promise<MarbleOperation> => {
      if (refuse) throw new Error("World Labs answered 402: insufficient credits");
      return { operationId: "op-1", done: false };
    }),
    getOperation: vi.fn(async (_id: string): Promise<MarbleOperation> => ({ operationId: "op-1", done: false, progress: "World generation in progress", worldId: "w1" })),
    getWorld: vi.fn(async (_id: string): Promise<MarbleWorld | null> => null),
  } satisfies MarbleClient;
  const make = (overrides = {}) =>
    createWorldService({
      store,
      client: marble,
      writeScene: scene,
      setTimer: (fn) => void timers.push(fn),
      sleep: async () => {},
      log: { info() {}, warn() {} },
      ...overrides,
    });
  /** run the timers that are due (each poll schedules the next) */
  const tick = async () => {
    const due = timers.splice(0);
    for (const fn of due) fn();
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { dir, store, marble, make, timers, tick };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("world service", () => {
  it("writes the scene, generates once, polls the operation and stores the splat URLs when ready", async () => {
    const { marble, make, tick, store } = rig();
    const worlds = make();

    const started = worlds.startWorld("chat-1", { topic: "What share of new cars in Norway are electric?", claims, sources });
    expect(started.status).toBe("started");
    // the record exists the moment startWorld returns
    expect(store.read("chat-1")).toMatchObject({ status: "generating", phase: "writing" });

    await vi.waitFor(() => expect(store.read("chat-1")?.phase).toBe("generating"));
    expect(marble.generate).toHaveBeenCalledTimes(1);
    expect(marble.generate.mock.calls[0]).toEqual([{ prompt: expect.stringContaining("charging plaza"), displayName: "Fjord Charging Plaza" }]);
    const generating = store.read("chat-1")!;
    expect(generating).toMatchObject({ title: "Fjord Charging Plaza", operationId: "op-1", model: "marble-1.1-plus" });
    // labels: the title, then the claim with its sources
    expect(generating.labels.map((l) => l.text)).toEqual(["Fjord Charging Plaza", "88.9% of new cars electric"]);
    expect(generating.labels[1].sources.map((s) => s.title)).toEqual(["OFV statistics", "Reuters on EVs"]);

    await tick();
    expect(store.read("chat-1")).toMatchObject({ status: "generating", progress: "World generation in progress", worldId: "w1" });

    marble.getOperation.mockResolvedValueOnce({
      operationId: "op-1",
      done: true,
      worldId: "w1",
      world: { worldId: "w1", marbleUrl: "https://marble.worldlabs.ai/world/w1", assets: { spz: { "500k": SPZ }, panoramaUrl: "https://cdn.example.test/pano.png" } },
    });
    await tick();
    expect(store.read("chat-1")).toMatchObject({
      status: "ready",
      worldId: "w1",
      marbleUrl: "https://marble.worldlabs.ai/world/w1",
      assets: { spz: { "500k": SPZ }, panoramaUrl: "https://cdn.example.test/pano.png" },
    });
    expect(worlds.running.has("chat-1")).toBe(false);
  });

  it("is one world per chat: a second start does nothing, whatever the first's status", async () => {
    const { marble, make, store } = rig();
    const worlds = make();
    expect(worlds.startWorld("chat-1", { topic: "EVs in Norway" }).status).toBe("started");
    expect(worlds.startWorld("chat-1", { topic: "something else" }).status).toBe("exists");
    await vi.waitFor(() => expect(store.read("chat-1")?.phase).toBe("generating"));
    expect(worlds.startWorld("chat-1", { topic: "again" }).status).toBe("exists");
    store.update("chat-1", { status: "error", error: "x" });
    expect(worlds.startWorld("chat-1", { topic: "after a failure" }).status).toBe("exists");
    expect(marble.generate).toHaveBeenCalledTimes(1);
  });

  it("marks the world failed when the operation fails, and when generate is refused", async () => {
    const failing = rig();
    const worlds = failing.make();
    worlds.startWorld("chat-1", { topic: "EVs" });
    await vi.waitFor(() => expect(failing.store.read("chat-1")?.phase).toBe("generating"));
    failing.marble.getOperation.mockResolvedValueOnce({ operationId: "op-1", done: true, error: "content policy" });
    await failing.tick();
    expect(failing.store.read("chat-1")).toMatchObject({ status: "error", error: "content policy" });

    const refused = rig({ refuse: true });
    refused.make().startWorld("chat-2", { topic: "EVs" });
    await vi.waitFor(() => expect(refused.store.read("chat-2")?.status).toBe("error"));
    expect(refused.store.read("chat-2")?.error).toContain("402");
  });

  it("does not start a world without World Labs configured", () => {
    const { make, store } = rig();
    const worlds = make({ client: null });
    expect(worlds.startWorld("chat-1", { topic: "EVs" }).status).toBe("unavailable");
    expect(store.read("chat-1")).toBeNull();
  });

  it("resumes polling from the stored operation after a restart, and never resubmits one cut off mid-submit", async () => {
    const { marble, make, store, tick } = rig();
    const at = Date.now();
    const base = { status: "generating" as const, title: "T", topic: "EVs", model: "marble-1.1-plus", labels: [], createdAt: at, updatedAt: at };
    store.write({ ...base, chatId: "chat-polling", phase: "generating", operationId: "op-9" });
    store.write({ ...base, chatId: "chat-submitting", phase: "submitting" });
    store.write({ ...base, chatId: "chat-done", status: "ready", assets: { spz: { "500k": SPZ } } });

    marble.getOperation.mockResolvedValue({
      operationId: "op-9",
      done: true,
      world: { worldId: "w9", marbleUrl: "https://marble.worldlabs.ai/world/w9", assets: { spz: { "500k": SPZ } } },
    });
    // a fresh process: a new service over the same folder
    const worlds = make();
    worlds.resume();
    expect(store.read("chat-submitting")).toMatchObject({ status: "error" });
    await tick();
    expect(marble.getOperation).toHaveBeenCalledWith("op-9");
    expect(store.read("chat-polling")).toMatchObject({ status: "ready", worldId: "w9" });
    expect(marble.generate).not.toHaveBeenCalled();
    await settle();
  });
});

describe("the World Labs client (mocked fetch)", () => {
  it("POSTs worlds:generate with marble-1.1-plus and a text prompt, and reads the operation back", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("worlds:generate")) {
        return Response.json({ operation_id: "op-1", done: false, error: null, metadata: null, response: null });
      }
      return Response.json({
        operation_id: "op-1",
        done: true,
        error: null,
        metadata: { progress: { status: "SUCCEEDED", description: "World generation completed successfully" }, world_id: "w1" },
        response: {
          id: "w1",
          world_marble_url: "https://marble.worldlabs.ai/world/w1",
          assets: {
            caption: "A plaza",
            thumbnail_url: "https://cdn.example.test/t.jpg",
            splats: { spz_urls: { "100k": "https://cdn.example.test/100k.spz", "500k": SPZ, full_res: "https://cdn.example.test/full.spz" }, semantics_metadata: { metric_scale_factor: 1.4, ground_plane_offset: 0.3 } },
            mesh: { collider_mesh_url: "https://cdn.example.test/c.glb" },
            imagery: { pano_url: "https://cdn.example.test/pano.png" },
          },
        },
      });
    });
    const client = createMarbleClient({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch });

    const op = await client.generate({ prompt: "Standing in a plaza", displayName: "Plaza" });
    expect(op).toEqual({ operationId: "op-1", done: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.worldlabs.ai/marble/v1/worlds:generate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["WLT-Api-Key"]).toBe("test-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "marble-1.1-plus",
      display_name: "Plaza",
      world_prompt: { type: "text", text_prompt: "Standing in a plaza" },
    });

    const done = await client.getOperation("op-1");
    expect(fetch.mock.calls[1][0]).toBe("https://api.worldlabs.ai/marble/v1/operations/op-1");
    expect(done).toMatchObject({
      done: true,
      worldId: "w1",
      world: {
        worldId: "w1",
        assets: {
          spz: { "500k": SPZ, full_res: "https://cdn.example.test/full.spz" },
          panoramaUrl: "https://cdn.example.test/pano.png",
          metricScaleFactor: 1.4,
          groundPlaneOffset: 0.3,
        },
      },
    });
  });
});

describe("labels", () => {
  it("places the title ahead and the rest on an arc in front of the start view", () => {
    const labels = buildLabels({ title: "Plaza", topic: "EVs", claims, sources });
    expect(labels[0]).toMatchObject({ text: "Plaza", position: [0, 3.2, -9], size: 2 });
    for (const [x, , z] of arcPositions(7)) {
      expect(z).toBeLessThan(0); // in front of the viewer
      expect(Math.abs(x)).toBeLessThan(Math.abs(z) * 2.5);
    }
  });
});
