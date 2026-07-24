"use client";

// The console - the auctioneer's screen, the only writer. CHARCOAL skin
// (globals.css .console scope) laid out to match the approved mockup: a top
// status strip, a two-column working area (current lot + sale entry on the
// left, up-next/nominations + night progress on the right), and a bottom TV
// bar. Restyle only - every data-testid, write() call, and piece of logic
// below is unchanged from the skeleton; see the HARD CONSTRAINT note in the
// build ticket. Part 2 adds the trade-entry form (the engine already existed
// via POST /api/trade; this file only adds the missing UI for it).
//
// Token: read from localStorage key 'commissionerToken', settable via the
// input at the top; sent as `Authorization: Bearer <token>` on every write.
//
// The live verdict line ports the handoff mockup's check() logic CLIENT-SIDE
// for instant feedback; the server (POST /api/draft) is the real defence and
// its response message is always surfaced verbatim.
//
// KNOWN PAYLOAD GAPS (skeleton scope - do not add payload fields here):
// - Per-position squad quotas are not in the payload, so "FWD full"
//   (position-ineligible) cannot be derived client-side; only the complete
//   squad case ("15/15") disables a button. The server still rejects
//   position-full sales.
// - The league minimum opening bid is not in the payload; the reserve figure
//   in the over-max message is derived as (remaining - maxBid)/(openSlots-1)
//   when openSlots > 1, and the clause is omitted otherwise.

import { useEffect, useRef, useState } from "react";
import type { ManagerState, StatePayload } from "@/lib/state";
import { usePolledPlayers } from "@/components/tv-common";

const TV_VIEWS = ["block", "reveal", "squads", "ledger", "paused"] as const;

function money(n: number | null | undefined): string {
  return n == null ? "?" : `$${n.toLocaleString()}`;
}

/** Digits-only text input -> integer, treating empty as null (price) or 0 (cash). */
function digitsOnly(text: string): string {
  return text.replace(/[^0-9]/g, "");
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

interface VerdictState {
  kind: "idle" | "bad" | "ok";
  msg: string;
}

/** Port of the handoff mockup's check(): the validation MESSAGES are the spec. */
function checkVerdict(
  lot: StatePayload["currentLot"],
  mgr: ManagerState | null,
  price: number | null,
): VerdictState {
  if (!mgr && price == null) {
    return { kind: "idle", msg: "Select a winner and enter the price." };
  }
  if (!mgr) {
    return { kind: "idle", msg: "Now select the winning manager." };
  }
  if (price == null) {
    return { kind: "idle", msg: `${mgr.short} selected - enter the hammer price.` };
  }
  if (lot && lot.openBid != null && price < lot.openBid) {
    return {
      kind: "bad",
      msg: `✗ Below the Tier ${lot.tier ?? "?"} opening bid ($${lot.openBid}).`,
    };
  }
  if (mgr.maxBid != null && price > mgr.maxBid) {
    if (mgr.openSlots > 1) {
      // Reserve per open slot, derived from payload data only (see header).
      const reserve = Math.round((mgr.remaining - mgr.maxBid) / (mgr.openSlots - 1));
      return {
        kind: "bad",
        msg:
          `✗ Over ${mgr.short}'s max bid of $${mgr.maxBid.toLocaleString()} - ` +
          `they must keep $${reserve} per open slot. Rejected.`,
      };
    }
    return {
      kind: "bad",
      msg: `✗ Over ${mgr.short}'s max bid of $${mgr.maxBid.toLocaleString()}. Rejected.`,
    };
  }
  return {
    kind: "ok",
    msg:
      `✓ Legal - ${mgr.short} pays $${price.toLocaleString()}, ` +
      `leaving $${(mgr.remaining - price).toLocaleString()}.`,
  };
}

export default function Console() {
  const { payload, connected } = usePolledState();
  // The whole-pool payload (#65): powers the phase-2 nominate-by-name search.
  // Read-only, version-gated, so a just-sold player drops out of the results.
  const { payload: playersPayload, connected: playersConnected } = usePolledPlayers();
  const [token, setToken] = useState("");
  const [winnerSlot, setWinnerSlot] = useState<number | null>(null);
  const [priceText, setPriceText] = useState("");
  // Phase-2 nomination search (#65): a free-text query over unsold players plus
  // the id the auctioneer has picked to put on the block (replaces the old raw
  // player-id input).
  const [nomQuery, setNomQuery] = useState("");
  const [selectedNomId, setSelectedNomId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- trade-entry form (Part 2) ----
  const [tradeOpen, setTradeOpen] = useState(false);
  const [tradeManagerA, setTradeManagerA] = useState("");
  const [tradeManagerB, setTradeManagerB] = useState("");
  const [tradePlayersAToB, setTradePlayersAToB] = useState<number[]>([]);
  const [tradePlayersBToA, setTradePlayersBToA] = useState<number[]>([]);
  const [tradeCashAText, setTradeCashAText] = useState("");
  const [tradeCashBText, setTradeCashBText] = useState("");
  const [tradeReason, setTradeReason] = useState("");
  // #24: a cash-only trade has no natural idempotency key, so a fast double
  // click on Submit could otherwise fire two identical POSTs before React
  // re-renders the disabled button. A ref is synchronous (unlike state), so
  // checking + setting it at the very top of the handler blocks the second
  // click before anything else runs, not just once the busy state lands.
  const submittingRef = useRef(false);

  useEffect(() => {
    setToken(window.localStorage.getItem("commissionerToken") ?? "");
  }, []);

  const lot = payload?.currentLot ?? null;
  const lotId = lot?.id ?? null;

  // A stale selection must never survive a lot change: clear the picked
  // winner, the typed price, and any in-progress nomination search whenever the
  // lot on the block changes (e.g. a nomination just landed).
  useEffect(() => {
    setWinnerSlot(null);
    setPriceText("");
    setNomQuery("");
    setSelectedNomId(null);
  }, [lotId]);

  const managers = payload?.managers ?? [];
  const winner = managers.find((m) => m.slot === winnerSlot) ?? null;
  const priceDigits = digitsOnly(priceText);
  const price = priceDigits ? parseInt(priceDigits, 10) : null;
  const verdict = checkVerdict(lot, winner, price);

  // ---- phase-2 nominate-by-name search (#65) ----
  // Match unsold players against the query (display name or raw name), most
  // last-season points first so marquee names surface. A short list keeps the
  // operator screen usable; a >=2 char floor avoids dumping the whole pool.
  const nomQ = nomQuery.trim().toLowerCase();
  const nomMatches =
    nomQ.length >= 2 && playersPayload
      ? playersPayload.players
          .filter(
            (p) =>
              !p.sold &&
              (`${p.displayName ?? ""}`.toLowerCase().includes(nomQ) ||
                `${p.name ?? ""}`.toLowerCase().includes(nomQ)),
          )
          .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))
          .slice(0, 8)
      : [];
  const selectedNom =
    selectedNomId != null
      ? playersPayload?.players.find((p) => p.id === selectedNomId) ?? null
      : null;

  // A manager picked on one side of a trade must never linger as an option
  // (or an owned-player list) on the other side.
  useEffect(() => {
    setTradePlayersAToB([]);
  }, [tradeManagerA]);
  useEffect(() => {
    setTradePlayersBToA([]);
  }, [tradeManagerB]);

  const tradeMgrA = managers.find((m) => String(m.id) === tradeManagerA) ?? null;
  const tradeMgrB = managers.find((m) => String(m.id) === tradeManagerB) ?? null;
  const tradeCashA = tradeCashAText ? parseInt(digitsOnly(tradeCashAText), 10) || 0 : 0;
  const tradeCashB = tradeCashBText ? parseInt(digitsOnly(tradeCashBText), 10) || 0 : 0;
  const tradeHasMovement =
    tradePlayersAToB.length > 0 ||
    tradePlayersBToA.length > 0 ||
    tradeCashA > 0 ||
    tradeCashB > 0;
  // Client-side, only guard against obviously-empty submits; the server is
  // the real defence (ownership, budgets, quotas, squad size).
  const tradeValid =
    tradeManagerA !== "" && tradeManagerB !== "" && tradeManagerA !== tradeManagerB && tradeHasMovement;

  function saveToken(v: string) {
    setToken(v);
    window.localStorage.setItem("commissionerToken", v);
  }

  /** Every write: bearer token, then ALWAYS surface the server's message. */
  async function write(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
    if (!token) {
      // Client-side: no token has been set at all.
      setStatus("Set the commissioner token first.");
      return { ok: false, data: null };
    }
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 401) {
        // Server-side: a token WAS sent and the server refused it.
        setStatus("Token rejected - check the commissioner token.");
      } else {
        const msg =
          (typeof data?.message === "string" && data.message) ||
          (typeof data?.error === "string" && data.error) ||
          (res.ok ? "Done." : `Request failed (HTTP ${res.status}).`);
        setStatus(`${res.ok ? "✓" : "✗"} ${msg}`);
      }
      return { ok: res.ok, data };
    } catch {
      setStatus("Network error - request failed.");
      return { ok: false, data: null };
    } finally {
      setBusy(false);
    }
  }

  async function recordSale() {
    if (!lot || !winner || price == null) return;
    const { ok } = await write("/api/draft", "POST", {
      playerId: lot.id,
      managerId: winner.id,
      price,
    });
    if (ok) {
      setWinnerSlot(null);
      setPriceText("");
    }
  }

  /** Phase-2 (#65): put the searched-and-selected player on the block. Sends
   * the same nominate action the old numeric input did; the server validates
   * the turn, that the player exists and is unsold, and puts it on the block. */
  async function nominate() {
    if (selectedNomId == null || payload?.nominationTurn == null) return;
    const { ok } = await write("/api/lot", "POST", {
      action: "nominate",
      playerId: selectedNomId,
      managerSlot: payload.nominationTurn,
    });
    if (ok) {
      setNomQuery("");
      setSelectedNomId(null);
    }
  }

  function toggleTradePlayer(side: "a" | "b", playerId: number) {
    const setFn = side === "a" ? setTradePlayersAToB : setTradePlayersBToA;
    setFn((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId],
    );
  }

  function resetTradeForm() {
    setTradeManagerA("");
    setTradeManagerB("");
    setTradePlayersAToB([]);
    setTradePlayersBToA([]);
    setTradeCashAText("");
    setTradeCashBText("");
    setTradeReason("");
    setTradeOpen(false);
  }

  async function submitTrade() {
    // See the #24 comment on submittingRef above: this check + set must be
    // the very first thing the handler does, before any await.
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const { ok } = await write("/api/trade", "POST", {
        managerA: parseInt(tradeManagerA, 10),
        managerB: parseInt(tradeManagerB, 10),
        playersAToB: tradePlayersAToB,
        playersBToA: tradePlayersBToA,
        cashAToB: tradeCashA,
        cashBToA: tradeCashB,
        reason: tradeReason.trim() || undefined,
      });
      // Reset on success so a late, accidental second click has nothing
      // left to resubmit.
      if (ok) resetTradeForm();
    } finally {
      submittingRef.current = false;
    }
  }

  // Night progress, derived from what the payload carries (managers[].squad
  // is the FULL owned list, not just recent sales). No-bid count is NOT
  // derivable from the payload (needs lot_events) - omitted.
  const soldCount = managers.reduce((n, m) => n + m.squad.length, 0);
  const totalSpend = managers.reduce((n, m) => n + m.spent, 0);
  const squadsComplete = managers.filter((m) => m.squadComplete).length;
  const tier1Remaining = payload
    ? (["GK", "DEF", "MID", "FWD"] as const).reduce(
        (n, p) => n + (payload.pool[p]?.[1] ?? 0),
        0,
      )
    : 0;

  const nominatorShort =
    payload?.nominationTurn != null
      ? managers.find((m) => m.slot === payload.nominationTurn)?.short ?? null
      : null;

  return (
    <main data-testid="console-page" className="screen console">
      <h1 className="con-h1">Console</h1>

      {/* ---- top status strip ---- */}
      <div className="con-status">
        <label>
          token{" "}
          <input
            data-testid="token-input"
            type="password"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
          />
        </label>
        <span data-testid="phase">phase {payload?.phase ?? "?"}</span>
        <span data-testid="paused">{payload?.paused ? "PAUSED" : "running"}</span>
        <button
          data-testid="pause-toggle"
          className="con-btn quiet"
          onClick={() =>
            write("/api/lot", "POST", { action: payload?.paused ? "resume" : "pause" })
          }
        >
          {payload?.paused ? "Resume" : "Pause"}
        </button>
        <span data-testid="poll-status">
          {connected ? "connected" : "connection lost - retrying"}
        </span>
        <span className={`con-live ${connected ? "on" : "off"}`}>
          <i className="con-dot" />
          {connected ? "BOARD LIVE" : "OFFLINE"}
        </span>
      </div>
      <p data-testid="write-status" className="write-status">
        {status || "no writes yet"}
      </p>

      <div className="con-grid">
        {/* ---- LEFT: current lot + sale entry ---- */}
        <section className="con-col">
          <h2 className="con-colh">Current lot - record the sale</h2>
          {lot ? (
            <div className="con-lotline">
              <span className="nm" data-testid="lot-name">
                {lot.displayName}
              </span>
              <span className="chip">
                T{lot.tier ?? "?"} - opens {money(lot.openBid)}
              </span>
              <span className="con-lotmeta">
                {lot.position} - {lot.teamShort ?? "?"}
              </span>
            </div>
          ) : (
            <p data-testid="lot-empty">No lot on the block.</p>
          )}

          <div className="con-mgr8">
            {managers.map((m) => {
              const size = m.squad.length + m.openSlots;
              // Only squad-complete ineligibility is derivable client-side;
              // position-full ("FWD full") needs quotas the payload lacks.
              const disabled = m.squadComplete;
              const selected = winnerSlot === m.slot;
              const sub = m.squadComplete
                ? `${m.squad.length}/${size}`
                : `max ${money(m.maxBid)}`;
              return (
                <button
                  key={m.slot}
                  data-testid={`manager-btn-${m.slot}`}
                  disabled={disabled}
                  className={`con-mgrbtn${selected ? " sel" : ""}${disabled ? " off" : ""}`}
                  onClick={() => setWinnerSlot(m.slot)}
                >
                  <span className="s">{m.short}</span>
                  <span className="x">{sub}</span>
                </button>
              );
            })}
          </div>

          <div className="con-pricerow">
            <input
              data-testid="price-input"
              className="con-priceinput"
              inputMode="numeric"
              placeholder="hammer price"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
            />
          </div>
          <p data-testid="verdict" className={`con-verdpill verdict ${verdict.kind}`}>
            {verdict.msg}
          </p>

          <div className="con-btnrow">
            <button
              data-testid="record-sale"
              className="con-btn primary"
              disabled={verdict.kind !== "ok" || !lot || busy}
              onClick={recordSale}
            >
              Record sale
            </button>
            <button
              data-testid="no-bid"
              className="con-btn quiet"
              disabled={busy}
              onClick={() => write("/api/lot", "POST", { action: "no_bid" })}
            >
              No bid
            </button>
            <button
              data-testid="trade-open"
              className="con-btn quiet"
              onClick={() => (tradeOpen ? resetTradeForm() : setTradeOpen(true))}
            >
              {tradeOpen ? "Close trade form" : "Enter a trade"}
            </button>
            <button
              data-testid="undo-sale"
              className="con-btn quiet"
              disabled={busy || !payload?.recentSales?.length}
              title={
                payload?.recentSales?.length ? undefined : "No sale visible to undo yet"
              }
              onClick={() => {
                // Double-submit guard: pin the undo to the newest sale this
                // console has SEEN (recentSales is newest-first). The server
                // rejects with stale_undo if the last sale changed meanwhile.
                // The button is disabled until a sale is visible, so there is
                // never an unguarded DELETE.
                const expectedSaleId = payload?.recentSales?.[0]?.saleId;
                if (expectedSaleId == null) return;
                if (window.confirm("Undo the last sale?")) {
                  write("/api/draft/latest", "DELETE", { expectedSaleId });
                }
              }}
            >
              Undo last
            </button>
          </div>

          {/* ---- trade-entry form: revealed by "Enter a trade" (#24 guard
              on submit lives in submitTrade above) ---- */}
          {tradeOpen && (
            <div className="con-trade">
              <div className="con-traderow">
                <div className="con-tradecol">
                  <label className="con-tlabel">
                    Manager A
                    <select
                      data-testid="trade-manager-a"
                      value={tradeManagerA}
                      onChange={(e) => setTradeManagerA(e.target.value)}
                    >
                      <option value="">Select...</option>
                      {managers
                        .filter((m) => String(m.id) !== tradeManagerB)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.short}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="con-plist">
                    {!tradeMgrA ? (
                      <p className="con-tempty">Select a manager.</p>
                    ) : tradeMgrA.squad.length === 0 ? (
                      <p className="con-tempty">No owned players.</p>
                    ) : (
                      tradeMgrA.squad.map((p) => (
                        <label key={p.playerId} className="con-ptoggle">
                          <input
                            type="checkbox"
                            data-testid={`trade-player-${p.playerId}`}
                            checked={tradePlayersAToB.includes(p.playerId)}
                            onChange={() => toggleTradePlayer("a", p.playerId)}
                          />
                          {p.displayName ?? p.name} ({p.position}) {money(p.price)}
                        </label>
                      ))
                    )}
                  </div>
                  <label className="con-tlabel">
                    Cash A to B
                    <input
                      data-testid="trade-cash-a"
                      inputMode="numeric"
                      placeholder="0"
                      value={tradeCashAText}
                      onChange={(e) => setTradeCashAText(e.target.value)}
                    />
                  </label>
                </div>

                <div className="con-tradecol">
                  <label className="con-tlabel">
                    Manager B
                    <select
                      data-testid="trade-manager-b"
                      value={tradeManagerB}
                      onChange={(e) => setTradeManagerB(e.target.value)}
                    >
                      <option value="">Select...</option>
                      {managers
                        .filter((m) => String(m.id) !== tradeManagerA)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.short}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="con-plist">
                    {!tradeMgrB ? (
                      <p className="con-tempty">Select a manager.</p>
                    ) : tradeMgrB.squad.length === 0 ? (
                      <p className="con-tempty">No owned players.</p>
                    ) : (
                      tradeMgrB.squad.map((p) => (
                        <label key={p.playerId} className="con-ptoggle">
                          <input
                            type="checkbox"
                            data-testid={`trade-player-${p.playerId}`}
                            checked={tradePlayersBToA.includes(p.playerId)}
                            onChange={() => toggleTradePlayer("b", p.playerId)}
                          />
                          {p.displayName ?? p.name} ({p.position}) {money(p.price)}
                        </label>
                      ))
                    )}
                  </div>
                  <label className="con-tlabel">
                    Cash B to A
                    <input
                      data-testid="trade-cash-b"
                      inputMode="numeric"
                      placeholder="0"
                      value={tradeCashBText}
                      onChange={(e) => setTradeCashBText(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <label className="con-tlabel con-treason">
                Reason (optional)
                <input
                  data-testid="trade-reason"
                  type="text"
                  value={tradeReason}
                  onChange={(e) => setTradeReason(e.target.value)}
                />
              </label>

              <div className="con-btnrow">
                <button
                  data-testid="trade-submit"
                  className="con-btn primary"
                  disabled={!tradeValid || busy}
                  onClick={submitTrade}
                >
                  Submit trade
                </button>
                <button className="con-btn quiet" disabled={busy} onClick={resetTradeForm}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ---- RIGHT: up next / nominations + night progress ---- */}
        <section className="con-col">
          <h2 className="con-colh">Up next</h2>
          {payload?.phase === 2 ? (
            <div data-testid="up-next">
              <p data-testid="nomination-turn">
                Nomination: Manager {payload.nominationTurn ?? "?"}
                {nominatorShort ? ` (${nominatorShort})` : ""}
              </p>
              {/* #65: search the pool by name and put the called player on the
                  block. Replaces the raw player-id input - the auctioneer types
                  the name they hear called, picks the match, and nominates. */}
              <div className="con-nom">
                <input
                  data-testid="nominate-search"
                  className="con-nominput"
                  type="text"
                  placeholder="search a player by name..."
                  value={nomQuery}
                  onChange={(e) => {
                    setNomQuery(e.target.value);
                    setSelectedNomId(null);
                  }}
                  aria-label="Search a player to nominate"
                />
                {selectedNomId == null && nomMatches.length > 0 && (
                  <ul className="con-nomlist" data-testid="nominate-results">
                    {nomMatches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          data-testid={`nominate-result-${p.id}`}
                          className="con-nomitem"
                          onClick={() => {
                            setSelectedNomId(p.id);
                            setNomQuery(p.displayName ?? p.name ?? "");
                          }}
                        >
                          <span className="nm">{p.displayName ?? p.name ?? "?"}</span>
                          <span className="con-nommeta">
                            {p.position} - {p.teamShort ?? "?"} - T{p.tier ?? "?"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Distinguish the empty states so the box never reads "no such
                    player" when the truth is "pool not loaded yet" or "type
                    more" (a live auctioneer must trust an empty result). */}
                {selectedNomId == null && nomQ.length >= 1 && playersPayload == null && (
                  <p className="con-tempty" data-testid="nominate-loading">
                    {playersConnected ? "Loading the player pool..." : "Connection lost - retrying..."}
                  </p>
                )}
                {selectedNomId == null && playersPayload != null && nomQ.length === 1 && (
                  <p className="con-tempty">Type at least 2 letters to search.</p>
                )}
                {selectedNomId == null && playersPayload != null && nomQ.length >= 2 && nomMatches.length === 0 && (
                  <p className="con-tempty" data-testid="nominate-noresults">
                    No unsold player matches &quot;{nomQuery.trim()}&quot;.
                  </p>
                )}
                {selectedNom && (
                  <p className="con-nomsel" data-testid="nominate-selected">
                    On the block: <strong>{selectedNom.displayName ?? selectedNom.name}</strong>{" "}
                    ({selectedNom.position} - {selectedNom.teamShort ?? "?"} - T{selectedNom.tier ?? "?"})
                  </p>
                )}
                <button
                  data-testid="nominate"
                  className="con-btn primary"
                  disabled={selectedNomId == null || payload.nominationTurn == null || busy}
                  onClick={nominate}
                >
                  Put on block
                </button>
              </div>
            </div>
          ) : (
            <ol data-testid="up-next" className="con-qlist">
              {(payload?.upNext ?? []).length === 0 && <li className="con-qrow">queue empty</li>}
              {(payload?.upNext ?? []).map((u) => (
                <li key={u.id} className="con-qrow">
                  {u.displayName} (T{u.tier ?? "?"})
                </li>
              ))}
            </ol>
          )}

          <h2 className="con-colh con-progh">Night progress</h2>
          <p data-testid="night-progress" className="con-prog">
            sold {soldCount} | spend {money(totalSpend)} | tier-1 left {tier1Remaining} |
            squads complete {squadsComplete}/{managers.length || "?"}
          </p>

          <div className="con-btnrow">
            <button
              data-testid="end-phase-one"
              className="con-btn blue"
              onClick={() => {
                if (window.confirm("End phase one and open nominations?")) {
                  write("/api/lot", "POST", { action: "end_phase_one" });
                }
              }}
            >
              End phase one
            </button>
          </div>
        </section>
      </div>

      {/* ---- bottom TV bar ---- */}
      <div className="con-tvbar">
        <span className="con-tvlabel">TV is showing</span>
        {TV_VIEWS.map((v) => (
          <button
            key={v}
            data-testid={`tv-${v}`}
            className={`con-tvopt${payload?.tvView === v ? " on" : ""}`}
            onClick={() => write("/api/lot", "POST", { action: "set_tv", view: v })}
          >
            {v}
          </button>
        ))}
      </div>

      <footer>
        <small data-testid="version">v{payload?.version ?? "-"}</small>
      </footer>
    </main>
  );
}
