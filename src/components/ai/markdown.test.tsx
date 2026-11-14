import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown, prepareMarkdown } from "@/components/ai/markdown";

/** Renders and lets Streamdown's lazy pieces (KaTeX, Shiki) settle. */
async function md(text: string, streaming = false) {
  const view = render(<Markdown streaming={streaming}>{text}</Markdown>);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return view.container.querySelector('[data-ai="markdown"]') as HTMLElement;
}

/** The visible text: KaTeX's MathML copy is for screen readers, not the page. */
const visible = (root: HTMLElement) => {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
  return clone.textContent ?? "";
};

describe("Markdown", () => {
  it("renders bold in ink, not as asterisks", async () => {
    const root = await md("Some **bold** text");
    const strong = root.querySelector("strong")!;
    expect(strong.textContent).toBe("bold");
    expect(strong.className).toContain("text-[var(--ai-ink)]");
    expect(visible(root)).not.toContain("**");
  });

  it("renders a bullet list and a numbered list", async () => {
    const root = await md("- one\n- two\n\n1. first\n2. second");
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("opens links in a new tab with noopener noreferrer", async () => {
    const root = await md("See [the docs](https://streamdown.ai).");
    const link = root.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://streamdown.ai/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("underline");
  });

  it("renders inline $…$ and block $$…$$ math with KaTeX", async () => {
    const root = await md("Inline $E=mc^2$ here.\n\n$$\\int_0^1 x^2\\,dx = \\tfrac13$$");
    const inline = root.querySelector("p .katex");
    expect(inline).not.toBeNull();
    expect(root.querySelector(".katex-display .katex")).not.toBeNull();
    expect(visible(root)).not.toContain("$");
  });

  it("renders \\( \\) and \\[ \\] math too", async () => {
    const root = await md("Inline \\(a^2+b^2\\) and\n\n\\[\\sum_{i=1}^n i\\]");
    expect(root.querySelector("p .katex")).not.toBeNull();
    expect(root.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps prices as text", async () => {
    const root = await md("It costs $5 and $10 per seat.");
    expect(root.querySelector(".katex")).toBeNull();
    expect(visible(root)).toBe("It costs $5 and $10 per seat.");
  });

  it("renders a fenced code block, laid out for real (no content-visibility guess)", async () => {
    const root = await md("```ts\nconst a = 1;\n```");
    const block = root.querySelector('[data-streamdown="code-block"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.dataset.language).toBe("ts");
    expect(block.querySelector("pre")?.textContent).toContain("const a = 1;");
    expect(visible(root)).not.toContain("```");
  });

  it("renders inline code as a chip", async () => {
    const root = await md("Run `npm test` now.");
    expect(root.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("npm test");
  });

  it("wraps a table in a sideways scroller with no visible scrollbar", async () => {
    const root = await md("| a | b |\n|---|---|\n| 1 | 2 |");
    const wrap = root.querySelector('[data-ai="md-table"]') as HTMLElement;
    expect(wrap.className).toContain("overflow-x-auto");
    expect(wrap.className).toContain("[scrollbar-width:none]");
    expect(wrap.querySelectorAll("th")).toHaveLength(2);
    expect(wrap.querySelectorAll("td")).toHaveLength(2);
  });

  it("doesn't show raw markers for half-arrived tokens mid-stream", async () => {
    const root = await md("Here is **bold te", true);
    expect(visible(root)).not.toContain("*");
    expect(root.querySelector("strong")?.textContent).toBe("bold te");

    const math = await md("Then\n\n$$\\int_0^1 x", true);
    expect(visible(math)).not.toContain("$$");

    const inline = await md("Inline: $E=mc^", true);
    expect(visible(inline).trim()).toBe("Inline:");

    const paren = await md("Inline \\(a^2 + b", true);
    expect(visible(paren).trim()).toBe("Inline");
  });
});

describe("prepareMarkdown", () => {
  it("leaves code alone", () => {
    const text = "```sh\necho $HOME \\(x\\)\n```\n\nand `$5` too";
    expect(prepareMarkdown(text)).toBe(text);
  });

  it("opens a one-line $$…$$ onto its own lines", () => {
    expect(prepareMarkdown("$$x^2$$")).toBe("$$\nx^2\n$$");
  });

  it("escapes a $ that can't open or close math", () => {
    expect(prepareMarkdown("from $5 to $10")).toBe("from \\$5 to \\$10");
    expect(prepareMarkdown("$x$ and $y$")).toBe("$x$ and $y$");
  });

  it("holds back a formula still arriving, only while streaming", () => {
    expect(prepareMarkdown("so $E=mc^", true)).toBe("so ");
    expect(prepareMarkdown("so $E=mc^")).toBe("so \\$E=mc^");
    // a closed formula and a finished price stay
    expect(prepareMarkdown("so $x$", true)).toBe("so $x$");
    expect(prepareMarkdown("from $5 to", true)).toBe("from \\$5 to");
  });

  it("holds back a marker with no content yet, only while streaming", () => {
    expect(prepareMarkdown("relation is **", true)).toBe("relation is ");
    expect(prepareMarkdown("Use `", true)).toBe("Use ");
    expect(prepareMarkdown("Code:\n\n```pyt", true)).toBe("Code:\n\n");
    expect(prepareMarkdown("2 * 3", true)).toBe("2 * 3");
    expect(prepareMarkdown("relation is **")).toBe("relation is **");
  });
});
