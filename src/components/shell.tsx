import { AppTransition } from "@/components/app-transition";
import { IconRail } from "@/components/icon-rail";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import type { View } from "@/lib/navigation";
import type { ReactNode } from "react";

/**
 * Shell — the layout grid. It holds no state: the route decides what is
 * active, `src/lib/navigation.ts` turns the pathname into a View, and every
 * region renders from it. Clicking a rail tile or a sidebar row is a real
 * navigation, so the URL, the active tile, the sidebar title, the washed row
 * and the breadcrumb all move together.
 *
 * Geometry measured from reference/target-1440x900@2x.png (CSS px @ 1440x900):
 *   top bar   y 0..40, full width, bg --plane-page, NO bottom border of its own
 *   icon rail x 0..60, flat page bg, NO border of its own
 *   sidebar   card spans x 60..310 (pulled -1px into the rail column)
 *   content   x 310..1432, y 40..892 — an inset card that draws all four of
 *             its own borders with an 8px radius; the 8px right / 8px bottom
 *             gutter below and beside it is page bg (8px on both edges).
 *
 * Edge ownership — verified against the PNG by the region agents, and the
 * reason the capture shows exactly 1px at every seam, never 2 and never 0:
 *   - The icon rail draws NO border. Rail and top bar are both #F2F2F3, so
 *     there is no visible line at y=40 over x 0..60 at all.
 *   - The line at x=60 is the SIDEBAR CARD's left border, not a rail border-r:
 *     it arcs into the card's rounded top-left (y~45) and bottom-left (y~887)
 *     corners and stops with the card at y=892. The card takes the column's
 *     full width plus one pixel (`-ml-px w-[250px]`) to sit on that seam.
 *   - The sidebar card is rounded on its LEFT corners only; its right corners
 *     are square and it draws no border-r. The line at x=310 is the content
 *     card's LEFT border.
 *   - The line at y=40 over x 310..1432 is the content card's own top border.
 * All six seams and all four corners measure 0 diff pixels; see scripts/seams.mjs.
 *
 * No fixed 1440x900 frame: the grid fills the viewport, so a Playwright
 * capture at exactly 1440x900 lands on the measured numbers.
 */
export function Shell({ view, content }: { view: View; content: ReactNode }) {
  // the route as this shell sees it: the app, plus the row within it
  const routeKey = view.app;

  return (
    <div className="grid h-full w-full grid-cols-[61px_249px_minmax(0,1fr)] grid-rows-[40px_1fr] bg-plane-page">
      <div className="col-span-3 row-start-1">
        <TopBar />
      </div>
      <div className="col-start-1 row-start-2 min-h-0">
        <IconRail active={view.app} />
      </div>
      <div className="col-start-2 row-start-2 min-h-0 pb-2">
        {/* the sidebar animates its own body, keyed by app */}
        <Sidebar view={view} />
      </div>
      <div className="col-start-3 row-start-2 min-h-0 min-w-0 pr-2 pb-2">
        {/* the pane swaps on any route change, not just an app change: the
            breadcrumb and the body below it belong to the same route */}
        <AppTransition id={routeKey} scope="pane" className="h-full">
          {content}
        </AppTransition>
      </div>
    </div>
  );
}
