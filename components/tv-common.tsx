"use client";

// Shared TV-canvas helpers for the room-facing screens (board, squads, ledger).
// Extracted from app/page.tsx so the new screens do not fork the poll/scale
// logic; app/page.tsx keeps its own copies untouched (it polls a different
// endpoint - /api/state - with a different payload shape).

import { useEffect, useRef, useState } from "react";
import clubColors from "@/lib/club-colors.json";
import { washForClub } from "@/lib/club-core.mjs";
import type { PlayersPayload } from "@/lib/players";

// Inline silhouette (no file dependency, works on any deploy).
export const SILHOUETTE =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20250%20250'%3E%3Crect%20width='250'%20height='250'%20fill='%232a2f2b'/%3E%3Cg%20fill='%23565c54'%3E%3Ccircle%20cx='125'%20cy='98'%20r='46'/%3E%3Cpath%20d='M40%20250c0-52%2038-84%2085-84s85%2032%2085%2084z'/%3E%3C/g%3E%3C/svg%3E";
export const PL = "https://resources.premierleague.com/premierleague";

export function money(n: number | null | undefined): string {
  return n == null ? "?" : `$${n.toLocaleString()}`;
}
/** 3-letter uppercase manager code (Manager 1 -> MAN), matching the mockup strip. */
export function abbr(s: string | null | undefined): string {
  return (s ?? "?").slice(0, 3).toUpperCase();
}

/** Club dot colour for a team short_name; a neutral grey when the club is unknown. */
export function clubDot(teamShort: string | null | undefined): string {
  return washForClub(clubColors as never, teamShort ?? null)?.bandFrom ?? "var(--muted)";
}

/**
 * Scale the 1600-wide board to the frame width. GUARDS against zero width: a
 * background-tab load measures clientWidth 0, and scale(0) renders a blank
 * board (the mockup bug). While width is 0 we keep scale unset and retry on the
 * next animation frame; we re-measure on resize, load and visibilitychange.
 */
export function useBoardScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    let raf = 0;
    function measure() {
      const el = ref.current;
      if (!el) return;
      const w = el.clientWidth;
      if (!w || w <= 0) {
        raf = requestAnimationFrame(measure); // never scale(0)
        return;
      }
      setScale(w / 1600);
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("load", measure);
    document.addEventListener("visibilitychange", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("load", measure);
      document.removeEventListener("visibilitychange", measure);
    };
  }, []);
  return { ref, scale };
}

/**
 * True on a phone-width viewport, false everywhere else (including during SSR
 * and the first client render, so there is no hydration mismatch). Mounted-
 * gated: only reads matchMedia after mount, then subscribes to changes.
 */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)");
    setIsPhone(mql.matches);
    function onChange(e: MediaQueryListEvent) {
      setIsPhone(e.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isPhone;
}

/** Poll /api/players (version-gated, keeps the last good payload on a blip). */
export function usePolledPlayers(): { payload: PlayersPayload | null; connected: boolean } {
  const [payload, setPayload] = useState<PlayersPayload | null>(null);
  const [connected, setConnected] = useState(true);
  const versionRef = useRef<number>(-1);
  const pollMs = payload?.pollMs ?? 2000;
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    async function tick() {
      if (inFlight) return;
      inFlight = true;
      const timeoutMs = pollMs * 2;
      let signal: AbortSignal;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (typeof AbortSignal.timeout === "function") {
        signal = AbortSignal.timeout(timeoutMs);
      } else {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), timeoutMs);
        signal = ctrl.signal;
      }
      try {
        const res = await fetch("/api/players", { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`players ${res.status}`);
        const data = (await res.json()) as PlayersPayload;
        if (disposed) return;
        setConnected(true);
        if (data.version > versionRef.current) {
          versionRef.current = data.version;
          setPayload(data);
        }
      } catch {
        if (!disposed) setConnected(false);
      } finally {
        inFlight = false;
        if (timer != null) clearTimeout(timer);
      }
    }
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [pollMs]);
  return { payload, connected };
}

// Local cached file -> PL CDN (data-cdn) -> inline silhouette. So the night
// runs off the local cache (no wifi dependency) but a fresh deploy still shows
// faces from the CDN.
export function photoErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.cdn && !el.dataset.cdnTried) {
    el.dataset.cdnTried = "1";
    el.src = el.dataset.cdn;
    return;
  }
  if (el.src.indexOf("data:image") === -1) el.src = SILHOUETTE;
}
// Crest: local -> CDN -> hide (a missing crest should not become a silhouette).
export function crestErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.cdn && !el.dataset.cdnTried) {
    el.dataset.cdnTried = "1";
    el.src = el.dataset.cdn;
    return;
  }
  el.style.display = "none";
}
