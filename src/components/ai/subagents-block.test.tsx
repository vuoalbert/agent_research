import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { relativeTime } from "@/components/ai/subagents-block";
import { AiThread } from "@/components/ai/thread";
import type { Message, Subagent, ToolCall } from "@/lib/agent-store";

vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => reduceMotion(),
}));
const reduceMotion = vi.fn(() => false);

/** The deploy_subagents block in the thread: a header, a tree of subagents, their own calls inside. */

const NOW = Date.now();
const subagent = (id: string, shape: Subagent["shape"], status: Subagent["status"], line: string): Subagent => ({
  id,
  title: `Angle ${id}`,
  shape,
  status,
  line,
  startedAt: NOW - 5_000,
  ...(status === "running" ? {} : { finishedAt: NOW - 2_000 }),
});
const group = (status: ToolCall["status"], subagents: Subagent[]): ToolCall => ({
  id: "g1",
  name: "Subagents",
  action: "subagents",
  query: subagents.map((s) => s.title).join(" · "),
  status,
  subagents,
});
const own = (id: string, agentId: string, query: string, action?: ToolCall["action"]): ToolCall => ({
  id,
  name: "Tavily",
  ...(action ? { action } : {}),
  query,
  status: "done",
  sources: [{ title: "T", url: `https://${id}.com` }],
  parentId: "g1",
  agentId,
});
const messages = (tools: ToolCall[]): Message[] => [
  { id: "u1", role: "user", content: "Solid-state batteries?", createdAt: 1 },
  { id: "a1", role: "assistant", content: "", createdAt: 2, tools },
];

const FIVE: Subagent[] = [
  subagent("a", "square", "running", "Searching “toyota solid-state”"),
  subagent("b", "circle", "done", "QuantumScape shipped B-samples"),
  subagent("c", "triangle", "running", "Reading samsungsdi.com"),
  subagent("d", "diamond", "error", "Timed out after 3 min"),
  subagent("e", "hexagon", "running", "Waiting to start"),
];

describe("SubagentsBlock", () => {
  beforeEach(() => reduceMotion.mockReturnValue(false));

  it("shows the group as one block, with its subagents' own calls kept out of the top-level rows", () => {
    const { container } = render(
      <AiThread
        streaming
        messages={messages([
          { id: "v", name: "Vault", action: "vault", op: "search", query: "ssb", status: "done", sources: [] },
          group("running", FIVE),
          own("s1", "a", "toyota solid-state"),
          own("s2", "c", "samsungsdi.com", "read"),
        ])}
      />,
    );
    const tools = container.querySelector('[data-ai="tools"]')!;
    // the vault row and the block, nothing else at the top level
    expect([...tools.children].map((el) => (el as HTMLElement).dataset.ai)).toEqual(["tool", "subagents"]);
    const block = tools.querySelector('[data-ai="subagents"]')!;
    expect(block.textContent).toContain("Running 5 subagents");
    expect(block.querySelectorAll('[data-ai="tool"]')).toHaveLength(0);

    const rows = [...block.querySelectorAll<HTMLElement>('[data-ai="subagent"]')];
    expect(rows.map((r) => r.querySelector('[data-ai="subagent-title"]')!.textContent)).toEqual([
      "Angle a",
      "Angle b",
      "Angle c",
      "Angle d",
      "Angle e",
    ]);
    expect(rows.map((r) => r.querySelector("svg[data-shape]")!.getAttribute("data-shape"))).toEqual([
      "square",
      "circle",
      "triangle",
      "diamond",
      "hexagon",
    ]);
    expect(rows[0].querySelector('[data-ai="subagent-line"]')!.textContent).toBe("Searching “toyota solid-state”");
    expect(rows[1].querySelector('[data-ai="subagent-line"]')!.textContent).toBe("QuantumScape shipped B-samples");
    expect(rows[1].querySelector('[data-ai="subagent-meta"]')!.textContent).toBe("Opus 5.5 · a few seconds ago");
  });

  it("spins a shape only while its subagent runs; an error is muted red", () => {
    const { container } = render(<AiThread messages={messages([group("running", FIVE)])} />);
    const shapes = [...container.querySelectorAll<SVGElement>("svg[data-shape]")];
    expect(shapes.map((s) => s.dataset.spinning)).toEqual(["true", "false", "true", "false", "true"]);
    expect(shapes[0].getAttribute("class")).toContain("animate-[spin_1.6s_linear_infinite]");
    expect(shapes[1].getAttribute("class")).not.toContain("animate-");
    expect(shapes[3].getAttribute("stroke")).toBe("#C46A62");
    expect(shapes[0].getAttribute("stroke")).not.toBe(shapes[1].getAttribute("stroke"));
  });

  it("does not spin under reduced motion", () => {
    reduceMotion.mockReturnValue(true);
    const { container } = render(<AiThread messages={messages([group("running", FIVE)])} />);
    const shapes = [...container.querySelectorAll<SVGElement>("svg[data-shape]")];
    expect(shapes.every((s) => s.dataset.spinning === "false")).toBe(true);
    expect(shapes.some((s) => (s.getAttribute("class") ?? "").includes("animate-"))).toBe(false);
  });

  it("says Ran once done, and stops every shape", () => {
    const done = FIVE.map((s) => ({ ...s, status: "done" as const, finishedAt: NOW }));
    const { container } = render(<AiThread messages={messages([group("done", done)])} />);
    expect(container.querySelector('[data-ai="subagents"]')!.textContent).toContain("Ran 5 subagents");
    expect([...container.querySelectorAll<SVGElement>("svg[data-shape]")].every((s) => s.dataset.spinning === "false")).toBe(true);
  });

  it("opens a subagent's own searches and reads as tool rows on click", () => {
    const { container } = render(
      <AiThread
        messages={messages([
          group("done", FIVE.slice(0, 2)),
          own("s1", "a", "toyota solid-state"),
          own("s2", "a", "global.toyota", "read"),
          own("s3", "b", "quantumscape"),
        ])}
      />,
    );
    const [first, second] = [...container.querySelectorAll<HTMLElement>('[data-ai="subagent"]')];
    const toggle = first.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const calls = [...first.querySelectorAll<HTMLElement>('[data-ai="tool"]')];
    expect(calls.map((c) => c.textContent)).toEqual(["Tavilytoyota solid-state", "TavilyReading global.toyota"]);
    expect(second.querySelectorAll('[data-ai="tool"]')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(first.querySelectorAll('[data-ai="tool"]')).toHaveLength(0);
  });
});

describe("relativeTime", () => {
  it("reads like a person would say it", () => {
    expect(relativeTime(0, 10_000)).toBe("a few seconds ago");
    expect(relativeTime(0, 60_000)).toBe("a minute ago");
    expect(relativeTime(0, 4 * 60_000)).toBe("4 minutes ago");
    expect(relativeTime(0, 60 * 60_000)).toBe("an hour ago");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3 hours ago");
    expect(relativeTime(0, 30 * 3_600_000)).toBe("a day ago");
  });
});
