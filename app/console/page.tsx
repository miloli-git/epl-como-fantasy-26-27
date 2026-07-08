"use client";

// The console - the auctioneer's screen, the only writer. SKELETON:
// deliberately unstyled, plain HTML, minimal inline layout.
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

const TV_VIEWS = ["block", "reveal", "squads", "ledger", "paused"] as const;

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
  const [token, setToken] = useState("");
  const [winnerSlot, setWinnerSlot] = useState<number | null>(null);
  const [priceText, setPriceText] = useState("");
  const [nomineeText, setNomineeText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(window.localStorage.getItem("commissionerToken") ?? "");
  }, []);

  const lot = payload?.currentLot ?? null;
  const lotId = lot?.id ?? null;

  // A stale selection must never survive a lot change: clear the picked
  // winner and the typed price whenever the lot on the block changes.
  useEffect(() => {
    setWinnerSlot(null);
    setPriceText("");
  }, [lotId]);

  const managers = payload?.managers ?? [];
  const winner = managers.find((m) => m.slot === winnerSlot) ?? null;
  const priceDigits = priceText.replace(/[^0-9]/g, "");
  const price = priceDigits ? parseInt(priceDigits, 10) : null;
  const verdict = checkVerdict(lot, winner, price);

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
      <h1>Console</h1>
      <p>
        <label>
          commissioner token{" "}
          <input
            data-testid="token-input"
            type="password"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
          />
        </label>
        {" | "}
        <span data-testid="phase">phase {payload?.phase ?? "?"}</span>
        {" | "}
        <span data-testid="paused">{payload?.paused ? "PAUSED" : "running"}</span>
        {" | "}
        <span data-testid="poll-status">
          {connected ? "connected" : "connection lost - retrying"}
        </span>
      </p>
      <p data-testid="write-status" className="write-status">
        {status || "no writes yet"}
      </p>

      {/* ---- current lot + sale entry ---- */}
      <section>
        <h2>Current lot</h2>
        {lot ? (
          <p>
            <strong data-testid="lot-name">{lot.name}</strong>
            {" | tier "}
            {lot.tier ?? "?"} | {lot.position} | {lot.teamShort ?? "?"} | opens{" "}
            {money(lot.openBid)}
          </p>
        ) : (
          <p data-testid="lot-empty">No lot on the block.</p>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {managers.map((m) => {
            const size = m.squad.length + m.openSlots;
            // Only squad-complete ineligibility is derivable client-side;
            // position-full ("FWD full") needs quotas the payload lacks.
            const disabled = m.squadComplete;
            const label = m.squadComplete
              ? `${m.short} ${m.squad.length}/${size}`
              : `${m.short} max ${money(m.maxBid)}`;
            return (
              <button
                key={m.slot}
                data-testid={`manager-btn-${m.slot}`}
                disabled={disabled}
                onClick={() => setWinnerSlot(m.slot)}
              >
                {winnerSlot === m.slot ? `[${label}]` : label}
              </button>
            );
          })}
        </div>

        <p>
          <label>
            hammer price{" "}
            <input
              data-testid="price-input"
              inputMode="numeric"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
            />
          </label>
        </p>
        <p data-testid="verdict" className={`verdict ${verdict.kind}`}>{verdict.msg}</p>
        <button
          data-testid="record-sale"
          className="primary"
          disabled={verdict.kind !== "ok" || !lot || busy}
          onClick={recordSale}
        >
          Record sale
        </button>
      </section>

      {/* ---- actions ---- */}
      <section>
        <h2>Actions</h2>
        <button
          data-testid="no-bid"
          disabled={busy}
          onClick={() => write("/api/lot", "POST", { action: "no_bid" })}
        >
          No bid - to phase two
        </button>{" "}
        <button
          data-testid="undo-sale"
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
          Undo last sale
        </button>{" "}
        <button
          data-testid="pause-toggle"
          onClick={() =>
            write("/api/lot", "POST", { action: payload?.paused ? "resume" : "pause" })
          }
        >
          {payload?.paused ? "Resume" : "Pause"}
        </button>{" "}
        <button
          data-testid="end-phase-one"
          onClick={() => {
            if (window.confirm("End phase one and open nominations?")) {
              write("/api/lot", "POST", { action: "end_phase_one" });
            }
          }}
        >
          End phase one
        </button>
      </section>

      {/* ---- up next / nominations ---- */}
      <section>
        <h2>Up next</h2>
        {payload?.phase === 2 ? (
          <div data-testid="up-next">
            <p data-testid="nomination-turn">
              Nomination: Manager {payload.nominationTurn ?? "?"}
              {nominatorShort ? ` (${nominatorShort})` : ""}
            </p>
            <p>
              <label>
                player id{" "}
                <input
                  data-testid="nominate-player-id"
                  inputMode="numeric"
                  value={nomineeText}
                  onChange={(e) => setNomineeText(e.target.value)}
                />
              </label>{" "}
              <button
                data-testid="nominate"
                disabled={!/^[0-9]+$/.test(nomineeText) || payload.nominationTurn == null}
                onClick={() =>
                  write("/api/lot", "POST", {
                    action: "nominate",
                    playerId: parseInt(nomineeText, 10),
                    managerSlot: payload.nominationTurn,
                  })
                }
              >
                Nominate
              </button>
            </p>
          </div>
        ) : (
          <ol data-testid="up-next">
            {(payload?.upNext ?? []).length === 0 && <li>queue empty</li>}
            {(payload?.upNext ?? []).map((u) => (
              <li key={u.id}>
                {u.name} (T{u.tier ?? "?"})
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ---- TV bar ---- */}
      <section>
        <h2>TV</h2>
        {TV_VIEWS.map((v) => (
          <button
            key={v}
            data-testid={`tv-${v}`}
            onClick={() => write("/api/lot", "POST", { action: "set_tv", view: v })}
          >
            {payload?.tvView === v ? `[${v}]` : v}
          </button>
        ))}
      </section>

      {/* ---- night progress ---- */}
      <section>
        <h2>Night progress</h2>
        <p data-testid="night-progress">
          sold {soldCount} | spend {money(totalSpend)} | tier-1 left {tier1Remaining} |
          squads complete {squadsComplete}/{managers.length || "?"}
        </p>
      </section>

      <footer>
        <small data-testid="version">v{payload?.version ?? "-"}</small>
      </footer>
    </main>
  );
}
