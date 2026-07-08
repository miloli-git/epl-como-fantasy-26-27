"use client";

// The board ("On the block") - THE HYBRID (mockup 05), detail-matched. A fixed
// 1600x900 TV canvas scaled to the viewport, club-washed per lot: coloured band
// + crest, value-over-label bio, big portrait on the club gradient, big
// nameplate; a centre spotlight (season points, per-game stat tiles, prior
// owner, morning brief, sealed line); a sold rail, tier-segmented pool bars,
// scarcity, trades; and a manager strip (max bid big, remaining small, quota
// fills). Polls /api/state (version-gated); keeps the last good payload on a blip.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { StatePayload } from "@/lib/state";
import clubColors from "@/lib/club-colors.json";
import { washForClub } from "@/lib/club-core.mjs";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
type Pos = (typeof POSITIONS)[number];

// Inline silhouette (no file dependency, works on any deploy).
const SILHOUETTE =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20250%20250'%3E%3Crect%20width='250'%20height='250'%20fill='%232a2f2b'/%3E%3Cg%20fill='%23565c54'%3E%3Ccircle%20cx='125'%20cy='98'%20r='46'/%3E%3Cpath%20d='M40%20250c0-52%2038-84%2085-84s85%2032%2085%2084z'/%3E%3C/g%3E%3C/svg%3E";
const PL = "https://resources.premierleague.com/premierleague";
// Grey shades for the pool bar's tier segments (T1 darkest -> T4 lightest).
const TIER_SHADE: Record<number, string> = { 1: "#3a3f38", 2: "#5c635a", 3: "#878e82", 4: "#b7bdb1" };

function money(n: number | null | undefined): string {
  return n == null ? "?" : `$${n.toLocaleString()}`;
}
/** 3-letter uppercase manager code (Milo -> MIL), matching the mockup strip. */
function abbr(s: string | null | undefined): string {
  return (s ?? "?").slice(0, 3).toUpperCase();
}

function usePolledState(): { payload: StatePayload | null; connected: boolean } {
  const [payload, setPayload] = useState<StatePayload | null>(null);
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
        const res = await fetch("/api/state", { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`state ${res.status}`);
        const data = (await res.json()) as StatePayload;
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

/**
 * Scale the 1600-wide board to the frame width. GUARDS against zero width: a
 * background-tab load measures clientWidth 0, and scale(0) renders a blank
 * board (the mockup bug). While width is 0 we keep scale unset and retry on the
 * next animation frame; we re-measure on resize, load and visibilitychange.
 */
function useBoardScale() {
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

// Local cached file -> PL CDN (data-cdn) -> inline silhouette. So the night
// runs off the local cache (no wifi dependency) but a fresh deploy still shows
// faces from the CDN.
function photoErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.cdn && !el.dataset.cdnTried) {
    el.dataset.cdnTried = "1";
    el.src = el.dataset.cdn;
    return;
  }
  if (el.src.indexOf("data:image") === -1) el.src = SILHOUETTE;
}
// Crest: local -> CDN -> hide (a missing crest should not become a silhouette).
function crestErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.cdn && !el.dataset.cdnTried) {
    el.dataset.cdnTried = "1";
    el.src = el.dataset.cdn;
    return;
  }
  el.style.display = "none";
}

function verdictPill(v: string | null): string {
  return v === "STEAL" ? "up" : v === "OVERPAY" ? "down" : "flat";
}

export default function Board() {
  const { payload, connected } = usePolledState();
  const { ref, scale } = useBoardScale();

  const lot = payload?.currentLot ?? null;
  const lotPos: Pos | null = (lot?.position as Pos | undefined) ?? null;
  const wash = lot ? washForClub(clubColors as never, lot.teamShort) : null;
  const reveal = payload && payload.tvView === "reveal" ? payload.reveal : null;

  const tierKeys: number[] = payload
    ? Array.from(new Set(POSITIONS.flatMap((p) => Object.keys(payload.pool[p] ?? {}).map(Number)))).sort((a, b) => a - b)
    : [];
  const poolMax = payload
    ? Math.max(1, ...POSITIONS.map((p) => tierKeys.reduce((n, t) => n + (payload.pool[p]?.[t] ?? 0), 0)))
    : 1;

  const clubVars = (wash
    ? { "--cb-from": wash.bandFrom, "--cb-to": wash.bandTo, "--cg": wash.photoGround, "--ct": wash.text, "--cs": wash.sub }
    : {}) as CSSProperties;

  // Operational status (connection + version): tiny + muted on the live board,
  // and the SSR-visible testids the test-ui contract greps for on the shell.
  const statusLine = (
    <span className="meta">
      <span data-testid="phase">phase {payload?.phase ?? "?"}</span>{" · "}
      <span data-testid="paused">{payload?.paused ? "PAUSED" : "live"}</span>{" · "}
      <span data-testid="tv-view">tv {payload?.tvView ?? "?"}</span>{" · "}
      <span data-testid="poll-status">{connected ? "connected" : "connection lost - retrying"}</span>{" · "}
      <small data-testid="version">v{payload?.version ?? "-"}</small>
    </span>
  );

  const ready = payload !== null && scale > 0;

  // stat tiles for the current lot
  const tiles = lot
    ? (() => {
        const st = lot.stats;
        const gp = Math.max(st.starts ?? 0, 1);
        const startedPct = st.starts != null ? Math.round((st.starts / 38) * 100) : null;
        return [
          { v: st.goals ?? "-", k: "Goals" },
          { v: st.assists ?? "-", k: "Assists" },
          { v: st.bonus ?? "-", k: "Bonus" },
          { v: startedPct != null ? `${startedPct}%` : "-", k: `Started ${st.starts ?? 0}/38` },
          { v: st.minutes != null ? Math.round(st.minutes / gp) : "-", k: "Mins/game" },
          { v: st.pts != null ? (st.pts / gp).toFixed(1) : "-", k: "Pts/game" },
        ];
      })()
    : [];

  return (
    <div data-testid="board-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>On the block</div>
            <div style={{ margin: "10px 0" }}>{statusLine}</div>
            <div>loading the room...</div>
          </div>
        ) : (
          <div className="board-canvas" style={clubVars}>
            {/* TOP BAR */}
            <div className="bcell b-top">
              <span className="kick">On the block</span>
              {lot?.lotNo != null && <span className="lotno">· Lot {lot.lotNo}</span>}
              {lot && (
                <span className="clubname">
                  <span className="clubdot" style={{ background: wash?.bandFrom ?? "#888" }} />
                  {(wash?.name ?? lot.teamShort ?? "").toUpperCase()}
                </span>
              )}
              <span className="spacer" />
              {lot && (
                <span className="facts">
                  Tier <b>{lot.tier ?? "?"}</b> · opens <b>{money(lot.openBid)}</b> · FPL <b>£{lot.fplPrice ?? "?"}</b>
                  {lot.stats.selectedBy != null && <> · owned <b>{lot.stats.selectedBy}%</b></>}
                </span>
              )}
              <span className="stat-tiny">{statusLine}</span>
            </div>

            {/* LEFT: the player */}
            <div className="bcell b-player">
              {lot ? (
                <>
                  <div className="b-band">
                    {lot.teamCode != null && (
                      <img
                        src={`/assets/badges/t${lot.teamCode}.png`}
                        data-cdn={`${PL}/badges/100/t${lot.teamCode}@x2.png`}
                        alt=""
                        onError={crestErr}
                      />
                    )}
                    <div className="b-band-txt">
                      <div className="club">{wash?.name ?? lot.teamShort ?? ""}</div>
                      {wash?.nick && <div className="clubsub">{wash.nick} · {wash.stadium}</div>}
                    </div>
                  </div>
                  <div className="b-bio">
                    <div><div className="bv">{lot.age ?? "-"}</div><div className="bk">Age</div></div>
                    <div><div className="bv">{lot.nationality ?? "-"}</div><div className="bk">Nation</div></div>
                    <div><div className="bv">{lot.heightCm ?? "-"}</div><div className="bk">CM</div></div>
                    <div><div className="bv">{lot.position}</div><div className="bk">Pos</div></div>
                  </div>
                  <div className="b-photo">
                    <img
                      src={lot.code != null ? `/assets/players/250/p${lot.code}.png` : SILHOUETTE}
                      data-cdn={lot.code != null ? `${PL}/photos/players/250x250/p${lot.code}.png` : undefined}
                      alt={lot.name}
                      onError={photoErr}
                    />
                    <div className="b-plate">
                      <div className="name" data-testid="lot-name">{lot.name}</div>
                      <div className="sub">
                        {[lot.firstName, lot.secondName].filter(Boolean).join(" ") || lot.name} · {wash?.name ?? lot.teamShort}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="b-band" style={{ background: "#333" }}>
                  <span className="club" data-testid="lot-empty">No lot on the block</span>
                </div>
              )}
            </div>

            {/* CENTER: spotlight */}
            <div className="bcell b-spot">
              {lot ? (
                <>
                  <div className="b-spot-head">
                    <div className="b-eyebrow">&apos;25 points</div>
                    <div className="b-points">
                      <span className="n">{lot.stats.pts ?? "-"}</span>
                      <span className="ranks">
                        {lot.overallRank != null && <div className="r1">#{lot.overallRank} of all players</div>}
                        {lot.positionRank != null && <div className="r2">#{lot.positionRank} in {lot.position}</div>}
                      </span>
                    </div>
                  </div>
                  <div className="b-spot-body">
                    <div className="b-stats">
                      {tiles.map((t, i) => (
                        <div className="b-stat" key={i}>
                          <div className="sv">{t.v}</div>
                          <div className="sk">{t.k}</div>
                        </div>
                      ))}
                    </div>
                    {lot.prevComoOwner && (
                      <div className="b-owner">
                        <span className="k">&apos;25 Como owner</span>
                        {lot.prevComoOwner}{lot.prevComoPrice != null ? ` · ${money(lot.prevComoPrice)}` : ""}
                      </div>
                    )}
                    {Array.isArray(lot.brief) && (lot.brief as unknown[]).length > 0 && (
                      <div className="b-brief">
                        <span className="k">Morning brief</span>
                        <ul>{(lot.brief as string[]).map((b, i) => <li key={i}>{b}</li>)}</ul>
                      </div>
                    )}
                    <span className="spacer" />
                    <div className="b-sealline">Claude value - sealed until the hammer</div>
                  </div>
                </>
              ) : (
                <div className="b-spot-body" style={{ color: "var(--muted)" }}>Between lots.</div>
              )}
            </div>

            {/* RIGHT: sold rail + pool + trades */}
            <div className="b-right">
              <div className="bcell">
                <div className="b-sechead">Recently sold</div>
                <ul data-testid="recent-sales" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {payload!.recentSales.length === 0 && <li className="pm">no sales yet</li>}
                  {payload!.recentSales.map((s) => (
                    <li key={s.playerId} className="sold-row">
                      <img
                        src={s.code != null ? `/assets/players/110/p${s.code}.png` : SILHOUETTE}
                        data-cdn={s.code != null ? `${PL}/photos/players/110x140/p${s.code}.png` : undefined}
                        alt=""
                        onError={photoErr}
                      />
                      <span className="pn">{s.playerName}</span>
                      <span className="pm">&rarr; {abbr(s.managerShort)}</span>
                      <span className="pp">
                        {money(s.price)}
                        {s.verdict && <span className={`pill ${verdictPill(s.verdict)}`} style={{ marginLeft: 8 }}>{s.verdict}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bcell">
                <div className="b-sechead">Pool · role x tier</div>
                <div data-testid="pool">
                  {POSITIONS.map((p) => {
                    const total = tierKeys.reduce((n, t) => n + (payload!.pool[p]?.[t] ?? 0), 0);
                    return (
                      <div className="pool-bar-row" key={p}>
                        <span className="plabel">{p}</span>
                        <span className="pool-bar">
                          {tierKeys.map((t) => {
                            const c = payload!.pool[p]?.[t] ?? 0;
                            return c > 0 ? <i key={t} style={{ width: `${(c / poolMax) * 100}%`, background: TIER_SHADE[t] ?? "#999" }} /> : null;
                          })}
                        </span>
                        <span className="pcount">{total}</span>
                      </div>
                    );
                  })}
                </div>
                <div data-testid="scarcity">
                  {payload!.scarcity.length > 0 && <div className="scar-box">&#9888; {payload!.scarcity.join(" · ")}</div>}
                </div>
              </div>
              <div className="bcell">
                <div className="b-sechead">Recent trades</div>
                <ul data-testid="recent-trades" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {payload!.recentTrades.length === 0 && <li className="pm">no trades yet</li>}
                  {payload!.recentTrades.map((t) => (
                    <li key={t.tradeId} className="sold-row">
                      <span className="pn">{abbr(t.managerAShort)} &harr; {abbr(t.managerBShort)}</span>
                      <span className="pm">
                        {t.players.map((p) => `${p.name ?? "#" + p.playerId} ${abbr(p.fromShort)}->${abbr(p.toShort)}`).join(", ")}
                        {(t.cashAToB > 0 || t.cashBToA > 0) && ` · $${(t.cashAToB || t.cashBToA).toLocaleString()}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* BOTTOM: manager strip (max bid big, remaining small, quota fills) */}
            <div className="b-mgrs">
              {payload!.managers.map((m) => {
                const size = m.squad.length + m.openSlots;
                const quota = payload!.squad;
                const posFull = lotPos != null && m.fills[lotPos] >= quota[lotPos];
                const hot = lotPos != null && !m.squadComplete && !posFull;
                return (
                  <div key={m.slot} data-testid={`manager-${m.slot}`} className={`b-mgr${hot ? " hot" : ""}${m.squadComplete || posFull ? " done" : ""}`}>
                    <div className="mn">{abbr(m.short)}<span className="mrem">{money(m.remaining)}</span></div>
                    {m.squadComplete ? (
                      <div className="tag big">{m.squad.length}/{size} Complete</div>
                    ) : posFull ? (
                      <div className="tag big">{lotPos} full</div>
                    ) : (
                      <div className="mr">{money(m.maxBid)}</div>
                    )}
                    <div className="mf">
                      {POSITIONS.map((p) =>
                        lotPos === p ? (
                          <span key={p}> · <b>{p[0]} {m.fills[p]}/{quota[p]}</b></span>
                        ) : (
                          <span key={p}>{p === POSITIONS[0] ? "" : " "}{p[0]}{m.fills[p]}</span>
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* reveal takeover */}
            {reveal && (
              <div className="b-reveal" data-testid="reveal">
                <div className="rp">{reveal.playerName} &rarr; {abbr(reveal.managerShort)}</div>
                <div className="rprice">Paid {money(reveal.price)}</div>
                <div className="rseal">Claude value {reveal.value == null ? "pending" : money(reveal.value)}</div>
                {reveal.verdict && (
                  <div className={`pill ${verdictPill(reveal.verdict)}`} style={{ fontSize: 22, padding: "4px 18px" }}>
                    {reveal.verdict}{reveal.delta != null ? ` ${money(reveal.delta)}` : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
