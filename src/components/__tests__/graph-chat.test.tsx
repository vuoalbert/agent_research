import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphChat, PLACEHOLDER, type AskGraph } from "@/components/graph-chat";
import type { GraphChatAnswer, GraphControls } from "@/lib/graph-highlight";
import type { ResearchGraph } from "@/lib/research-graph";

const GRAPH: ResearchGraph = {
  nodes: [
    { id: "chat:a", kind: "chat", label: "Chat A" },
    { id: "page:x", kind: "page", label: "X", url: "https://x.org/" },
    { id: "page:y", kind: "page", label: "Y", url: "https://y.org/" },
  ],
  links: [
    { id: "read:x", kind: "read", source: "chat:a", target: "page:x" },
    { id: "conflicts:xy", kind: "conflicts", source: "page:x", target: "page:y" },
  ],
};

function setup(ask: AskGraph, graph = GRAPH) {
  const controls = createRef<GraphControls | null>() as { current: GraphControls | null };
  const api = { focusNode: vi.fn(() => true), setHighlight: vi.fn(), getGraph: () => graph };
  controls.current = api;
  render(<GraphChat controls={controls} ask={ask} />);
  const input = screen.getByPlaceholderText(PLACEHOLDER);
  const send = (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(input.closest("form")!);
  };
  return { api, input, send };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(cleanup);

describe("GraphChat", () => {
  it("sends the question with the drawn graph, shows pending, then the reply, focus and highlight", async () => {
    const pending = deferred<GraphChatAnswer>();
    const ask = vi.fn<AskGraph>(() => pending.promise);
    const { api, send } = setup(ask);
    send("what conflicts?");

    expect(ask).toHaveBeenCalledTimes(1);
    const [question, graph] = ask.mock.calls[0];
    expect(question).toBe("what conflicts?");
    expect(graph.nodes.map((n) => [n.id, n.degree])).toEqual([["chat:a", 1], ["page:x", 2], ["page:y", 1]]);
    expect(screen.getByRole("button", { name: "Asking…" })).toHaveProperty("disabled", true);
    expect(document.querySelector("form")!.getAttribute("aria-busy")).toBe("true");

    await act(async () => pending.resolve({ reply: "X and Y disagree.", focus: "page:x", highlight: ["page:x", "page:y"] }));
    expect(screen.getByRole("status").textContent).toBe("X and Y disagree.");
    expect(api.setHighlight).toHaveBeenLastCalledWith(["page:x", "page:y"]);
    expect(api.focusNode).toHaveBeenCalledWith("page:x");
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true); // empty again
  });

  it("flies without dimming when the answer only has a focus", async () => {
    const { api, send } = setup(async () => ({ reply: "Here is Y.", focus: "page:y", highlight: [] }));
    send("take me to Y");
    await waitFor(() => expect(api.focusNode).toHaveBeenCalledWith("page:y"));
    expect(api.setHighlight).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("Clear and the reply's dismiss restore the graph and hide the bubble", async () => {
    const { api, send } = setup(async () => ({ reply: "Both.", focus: null, highlight: ["page:x"] }));
    send("x?");
    await screen.findByText("Clear");
    expect(api.focusNode).toHaveBeenCalledWith("page:x"); // no focus: the first highlighted
    fireEvent.click(screen.getByText("Clear"));
    expect(api.setHighlight).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("Clear")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss reply" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Escape clears a highlight without reaching the view; with none, it reaches the view", async () => {
    const viewEscape = vi.fn();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) viewEscape();
    };
    document.addEventListener("keydown", onKey);
    try {
      const { api, send, input } = setup(async () => ({ reply: "Both.", focus: null, highlight: ["page:x"] }));
      send("x?");
      await screen.findByText("Clear");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(api.setHighlight).toHaveBeenLastCalledWith(null);
      expect(viewEscape).not.toHaveBeenCalled();
      expect(screen.queryByText("Clear")).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(viewEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", onKey);
    }
  });

  it("keeps typed keys from the graph's window listeners", () => {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      const { input } = setup(vi.fn());
      fireEvent.keyDown(input, { key: "a" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  it("shows an error, and answers an empty graph locally", async () => {
    const { send } = setup(async () => {
      throw new Error("graph chat stopped: error_max_turns");
    });
    send("x?");
    expect((await screen.findByRole("status")).textContent).toContain("error_max_turns");
    cleanup();
    const ask = vi.fn<AskGraph>();
    const empty = setup(ask, { nodes: [], links: [] });
    empty.send("x?");
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("empty");
  });
});
