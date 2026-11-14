import { describe, expect, it } from "vitest";

import { WHITE_FIGURE_STYLE, whiteFigure } from "@/server/visualize/white-figure";

describe("whiteFigure", () => {
  it("adds the white-background style just before </head>", () => {
    const out = whiteFigure("<html><head><title>x</title></head><body>hi</body></html>");
    expect(out).toBe(`<html><head><title>x</title>${WHITE_FIGURE_STYLE}</head><body>hi</body></html>`);
    expect(out).toContain("--anatomy-page:#fff!important");
    expect(out).toContain("--anatomy-card:#fff!important");
    expect(out).toContain("--anatomy-paper:#fff!important");
  });

  it("prepends the style when the page has no head", () => {
    expect(whiteFigure("<body>hi</body>")).toBe(`${WHITE_FIGURE_STYLE}<body>hi</body>`);
  });

  it("does not add it twice", () => {
    const once = whiteFigure("<head></head>");
    expect(whiteFigure(once)).toBe(once);
  });
});
