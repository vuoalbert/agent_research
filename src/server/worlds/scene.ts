import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Claim } from "@/lib/crossref";
import { hostOf } from "@/lib/source-key";
import type { WorldSource } from "@/lib/worlds";

import { shorten, type LabelDraft } from "./labels";

/**
 * The scene for a chat's world, written by Claude in one nested, tool-less
 * `query()` with structured output: a short title, a World Labs text prompt
 * for one physical, photoreal place that embodies the research topic (no real
 * brands or logos), and up to seven short floating labels for its key facts,
 * each with a search topic and the claim it comes from. If that call fails,
 * `fallbackScene` writes a plain one, so a world never waits on it.
 */

export const SCENE_MODEL = "claude-opus-5-5";

export type SceneInput = {
  topic: string;
  answer?: string;
  claims?: readonly Claim[];
  sources?: readonly WorldSource[];
};

export type Scene = { title: string; prompt: string; labels: LabelDraft[] };

export const SceneSchema = z.object({
  title: z.string().min(1).max(64),
  prompt: z.string().min(40).max(2000),
  labels: z
    .array(
      z.object({
        text: z.string().min(1).max(60),
        query: z.string().min(1).max(120),
        claim: z.number().int().min(1).optional(),
      }),
    )
    .max(7),
});

export function sceneJsonSchema(): Record<string, unknown> {
  const { $schema: _uri, ...schema } = z.toJSONSchema(SceneSchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

const SCENE_SYSTEM = [
  "You design a walkable 3D world (a World Labs Marble scene) for a piece of research, plus its floating labels.",
  "Scene prompt rules:",
  "- One physical, photoreal place you can stand in that embodies the research topic (a lab, a factory floor, a street, a landscape, a control room, a museum hall…), described from where the viewer stands: 'Standing in …'.",
  "- 90-160 words of concrete visual detail: architecture, objects, materials, lighting, time of day, weather, depth (near, middle, far).",
  "- No real brands, logos, company names, readable text, signage words or real people. Invented, abstract signage only.",
  "- End with: 'Cinematic, photorealistic, sharp detail, crisp textures.'",
  "Title: 2-5 words naming the place.",
  "Labels: up to 7, each a key fact or claim from the research in at most 40 characters (numbers welcome, e.g. '88.9% of new cars electric'),",
  "with a 2-6 word encyclopedia-style search topic for its sources, and the number of the claim it comes from when it comes from one.",
].join("\n");

export function scenePrompt({ topic, answer, claims = [], sources = [] }: SceneInput): string {
  const lines = [`Research question: ${topic}`];
  if (answer?.trim()) lines.push("", "Answer (excerpt):", answer.trim().slice(0, 1800));
  if (claims.length) {
    lines.push("", "Cross-referenced claims:");
    claims.slice(0, 20).forEach((claim, i) => {
      const hosts = [...new Set(claim.sources.map((s) => hostOf(s.url)))].join(", ");
      lines.push(`${i + 1}. ${claim.text}${hosts ? ` (${hosts})` : ""}`);
    });
  }
  if (sources.length) {
    lines.push("", "Sources:");
    for (const source of sources.slice(0, 12)) lines.push(`- ${source.title} (${hostOf(source.url)})`);
  }
  return lines.join("\n");
}

export type WriteScene = (input: SceneInput, signal?: AbortSignal) => Promise<Scene>;

export const writeSceneWithClaude: WriteScene = async (input, signal) => {
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort());
  const run = query({
    prompt: scenePrompt(input),
    options: {
      model: SCENE_MODEL,
      effort: "low",
      systemPrompt: SCENE_SYSTEM,
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: sceneJsonSchema() },
      maxTurns: 3,
      abortController,
    },
  });
  for await (const message of run) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`scene writing stopped: ${message.subtype}`);
    const raw = message.structured_output ?? JSON.parse(/\{[\s\S]*\}/.exec(message.result ?? "")?.[0] ?? "null");
    return SceneSchema.parse(raw);
  }
  throw new Error("scene writing returned no result");
};

/** a plain scene when Claude cannot write one: the topic as a place, no labels of its own */
export function fallbackScene({ topic }: SceneInput): Scene {
  const subject = shorten(topic, 120);
  return {
    title: shorten(topic, 40),
    prompt:
      `Standing in the middle of a spacious, sunlit research hall dedicated to ${subject}. ` +
      "Large physical models, instruments and exhibits about the subject fill the room on low plinths and long work tables; " +
      "tall windows let warm afternoon light rake across polished concrete floors; shelves of books, sample cases and " +
      "abstract diagram panels with invented symbols line the walls; a mezzanine walkway overhead, plants in the corners, " +
      "soft haze in the distance. No real brands, logos or readable text. Cinematic, photorealistic, sharp detail, crisp textures.",
    labels: [],
  };
}
