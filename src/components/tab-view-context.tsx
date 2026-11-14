"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { SideTabLabel } from "@/components/side-tabs";

/**
 * Which side tab, if any, has its full-width view open — shared between the
 * tab stack that opens it and the shell-level view that draws it. The opener
 * is kept so closing can hand focus back to the tab it came from.
 */
type TabView = {
  view: SideTabLabel | null;
  openView: (label: SideTabLabel, opener: HTMLElement | null) => void;
  closeView: () => void;
  /** the element that opened the current view, for focus return */
  openerRef: { readonly current: HTMLElement | null };
};

const TabViewContext = createContext<TabView | null>(null);

export function TabViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<SideTabLabel | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openView = useCallback((label: SideTabLabel, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setView(label);
  }, []);
  const closeView = useCallback(() => setView(null), []);

  const value = useMemo(
    () => ({ view, openView, closeView, openerRef }),
    [view, openView, closeView],
  );
  return <TabViewContext.Provider value={value}>{children}</TabViewContext.Provider>;
}

/** null outside a provider: there every tab falls back to its side panel */
export function useTabView() {
  return useContext(TabViewContext);
}
