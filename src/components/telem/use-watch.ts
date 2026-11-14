"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { updatesEndpoint, type WatchUpdates } from "@/lib/telem-watch";

/**
 * A chat's watch, polled from the server's record (a local file read, no
 * Telem call): its monitors, the sources their findings came from, and what
 * is new. Every 60 s, and again when the window regains focus.
 */

const EVERY_MS = 60_000;

export function useWatchUpdates(chatId: string | null | undefined) {
  const [updates, setUpdates] = useState<WatchUpdates | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!chatId) return;
    try {
      const response = await fetch(updatesEndpoint(chatId), { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as WatchUpdates;
      if (alive.current) setUpdates(next);
    } catch {
      /* offline or the server restarting: the next poll tries again */
    }
  }, [chatId]);

  useEffect(() => {
    alive.current = true;
    setUpdates(null);
    if (!chatId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), EVERY_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [chatId, refresh]);

  const markSeen = useCallback(async () => {
    if (!chatId) return;
    try {
      await fetch(updatesEndpoint(chatId), { method: "POST" });
    } catch {
      return;
    }
    void refresh();
  }, [chatId, refresh]);

  return { updates, refresh, markSeen };
}
