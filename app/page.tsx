"use client";

// The board ("On the block") - SKELETON. Deliberately unstyled: plain HTML,
// minimal inline layout only; the design system lands in a later run.
// Polls GET /api/state every payload.pollMs (fallback 2000) and re-renders
// only when the state version changes. On poll failure the last good payload
// stays on screen with a "connection lost - retrying" note (venue wifi).

import { useEffect, useRef, useState } from "react";
import type { StatePayload } from "@/lib/state";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
type Pos = (typeof POSITIONS)[number];

function money(n: number | null | undefined): string {
  return n == null ? "?" : `$${n.toLocaleString()}`;
}

/** Poll /api/state; setInterval + AbortController cleanup; version-gated. */
function usePolledState(): { payload: StatePayload | null; connected: boolean } {
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [connected, setConnected] = useState(true);
  const versionRef = useRef<number>(-1);
  const pollMs = payload?.pollMs ?? 2000;

  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    async function tick() {
      // Skip this tick while the previous fetch is still in flight - no
      // pile-up of parallel requests on a slow or hung connection.
      if (inFlight) return;
      inFlight = true;
      // Bound every fetch to 2x the poll interval.
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
        const res = await fetch("/api/state", { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`state ${res.status}`);
        const data = (await res.json()) as StatePayload;
        if (disposed) return;
        setConnected(true);
        // Monotonic gate: an out-of-order slow response can never render
        // an older version over a newer one.
        if (data.version > versionRef.current) {
          versionRef.current = data.version;
          setPayload(data);
        }
      } catch {
        // Keep the last good payload; just flag the connection.
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

export default function Board() {
  const { payload, connected } = usePolledState();
  const lot = payload?.currentLot ?? null;
  const lotPos: Pos | null = (lot?.position as Pos | undefined) ?? null;

  // Tier columns for the pool table, from whatever tiers the payload carries.
  const tierKeys: number[] = payload
    ? Array.from(
        new Set(
          POSITIONS.flatMap((p) =>
            Object.keys(payload.pool[p] ?? {}).map(Number),
          ),
        ),
      ).sort((a, b) => a - b)
    : [];

  return (
    <main data-testid="board-page" style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>On the block</h1>
      <p>
        <span data-testid="phase">phase {payload?.phase ?? "?"}</span>
        {" | "}
        <span data-testid="paused">{payload?.paused ? "PAUSED" : "running"}</span>
        {" | "}
        <span data-testid="tv-view">tv: {payload?.tvView ?? "?"}</span>
        {" | "}
        <span data-testid="poll-status">
          {connected ? "connected" : "connection lost - retrying"}
        </span>
      </p>

      {payload === null ? (
        <p>loading state...</p>
      ) : (
        <>
          {/* ---- reveal takeover ---- */}
          {payload.tvView === "reveal" && payload.reveal && (
            <section data-testid="reveal" style={{ border: "3px solid black", padding: 8 }}>
              <h2>
                {payload.reveal.playerName} {"->"} {payload.reveal.managerShort ?? "?"}
              </h2>
              <p>
                paid {money(payload.reveal.price)}
                {" | value "}
                {payload.reveal.value == null ? "value pending" : money(payload.reveal.value)}
                {" | delta "}
                {payload.reveal.delta == null ? "value pending" : money(payload.reveal.delta)}
                {" | "}
                {payload.reveal.verdict ?? "value pending"}
              </p>
            </section>
          )}

          {/* ---- current lot ---- */}
          <section>
            <h2>Current lot</h2>
            {lot ? (
              <p>
                <strong data-testid="lot-name">{lot.name}</strong>
                {" | "}
                {lot.position} | {lot.teamShort ?? "?"} | tier {lot.tier ?? "?"} | opens{" "}
                {money(lot.openBid)} | FPL {lot.fplPrice ?? "?"} | {lot.stats.pts ?? "?"} pts
              </p>
            ) : (
              <p data-testid="lot-empty">No lot on the block.</p>
            )}
          </section>

          {/* ---- manager strip ---- */}
          <section>
            <h2>Managers</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {payload.managers.map((m) => {
                const size = m.squad.length + m.openSlots;
                return (
                  <div
                    key={m.slot}
                    data-testid={`manager-${m.slot}`}
                    style={{ border: "1px solid black", padding: 6 }}
                  >
                    <div>
                      <strong>{m.short}</strong> {money(m.remaining)} left
                    </div>
                    <div>
                      {m.squadComplete
                        ? `${m.squad.length}/${size}`
                        : `max ${money(m.maxBid)}`}
                    </div>
                    {/* Fills; the current lot's position is marked [X n]. The
                        marker (and card) grey out when the squad is complete.
                        NOTE: per-position quota denominators (e.g. "D 4/5")
                        are not in the state payload - counts only here. */}
                    <div style={m.squadComplete ? { color: "#999" } : undefined}>
                      {POSITIONS.map((p) => {
                        const label = `${p[0]} ${m.fills[p]}`;
                        return (
                          <span key={p} style={{ marginRight: 6 }}>
                            {lotPos === p ? `[${label}]` : label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---- recent sales ---- */}
          <section>
            <h2>Recently sold</h2>
            <ul data-testid="recent-sales">
              {payload.recentSales.length === 0 && <li>no sales yet</li>}
              {payload.recentSales.map((s) => (
                <li key={s.playerId}>
                  {s.playerName} {"->"} {s.managerShort ?? "?"} {money(s.price)}
                  {s.value != null && (
                    <>
                      {" | value "}
                      {money(s.value)} {s.verdict ?? ""}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* ---- recent trades ---- */}
          {/* Structural only, no design tokens: the board announces recorded
              trades (players moved + cash). Styling lands with the design run. */}
          <section>
            <h2>Recent trades</h2>
            <ul data-testid="recent-trades">
              {payload.recentTrades.length === 0 && <li>no trades yet</li>}
              {payload.recentTrades.map((t) => (
                <li key={t.tradeId}>
                  <strong>
                    {t.managerAShort ?? "?"} {"<->"} {t.managerBShort ?? "?"}
                  </strong>
                  {t.players.map((p) => (
                    <span key={p.playerId} style={{ marginLeft: 8 }}>
                      {p.name ?? `#${p.playerId}`} {p.fromShort ?? "?"} {"->"} {p.toShort ?? "?"}
                    </span>
                  ))}
                  {t.cashAToB > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      cash {t.managerAShort ?? "?"} {"->"} {t.managerBShort ?? "?"} {money(t.cashAToB)}
                    </span>
                  )}
                  {t.cashBToA > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      cash {t.managerBShort ?? "?"} {"->"} {t.managerAShort ?? "?"} {money(t.cashBToA)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* ---- pool counts ---- */}
          <section>
            <h2>Pool (position x tier)</h2>
            <table data-testid="pool" border={1} cellPadding={4}>
              <thead>
                <tr>
                  <th>pos</th>
                  {tierKeys.map((t) => (
                    <th key={t}>T{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {POSITIONS.map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    {tierKeys.map((t) => (
                      <td key={t}>{payload.pool[p]?.[t] ?? 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* ---- scarcity alerts ---- */}
          <section>
            <h2>Scarcity</h2>
            <ul data-testid="scarcity">
              {payload.scarcity.length === 0 && <li>none</li>}
              {payload.scarcity.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      <footer>
        <small data-testid="version">v{payload?.version ?? "-"}</small>
      </footer>
    </main>
  );
}
