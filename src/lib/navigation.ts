import { RAIL_TABS } from "@/data/nav";

/**
 * Turns a rail app into what the chrome should render. The app has a single
 * tab, AI, served at `/`.
 */

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export type View = {
  /** active rail app, by label */
  app: string;
};

/** every rail tab lives at the root: AI is the whole app */
export function hrefForApp(_label: string): string {
  return "/";
}

export function viewForApp(slug: string): View | null {
  const tab = RAIL_TABS.find((t) => slugify(t.label) === slug);
  return tab ? { app: tab.label } : null;
}

/** the view at `/` */
export function defaultView(): View {
  return { app: "AI" };
}
