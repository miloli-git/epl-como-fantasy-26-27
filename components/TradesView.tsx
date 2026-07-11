"use client";

// The trades log (#58): a read-only history of every recorded trade, newest
// first. Like the recap, this sits OUTSIDE the live 2s loop - trades are
// post-hoc events, not something that changes mid-render the way the board
// does - so it fetches /api/trades once on mount, with a manual refresh
// button, the same pattern as RecapView.
//
// SEALING: a trade never carries a player's sealed value, only identity and
// cash (see lib/trades-core.mjs); this view renders exactly what the payload
// gives it and never reads a value here.
//
// One responsive column (not the scaled TV canvas) - a trade log reads fine
// as plain reflowing HTML on both the TV and a phone, so there is no separate
// phone sub-component the way the board/squads/ledger have one. PhoneNav is
// still rendered on the phone path (gated by useIsPhone(), matching how
// LedgerView only mounts it inside its phone branch) so trades stays reachable
// from the same persistent tab bar as the other room-facing screens.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { TradeMovePlayer, TradeRow, TradesPayload } from "@/lib/trades";
import { PhoneNav, abbr, clubDot, money, useIsPhone } from "./tv-common";

/** A moved player: club dot + disambiguated name (linked) + position. The club
 *  rides in the dot (and in the name's "(CLUB)" qualifier when a surname is
 *  shared), so it is not repeated as text - same visual grammar as the manager
 *  page rows. */
function PlayerMoveLink({ p }: { p: TradeMovePlayer }) {
  return (
    <>
      <span className="tr-dot" style={{ background: clubDot(p.teamShort) }} aria-hidden />
      <Link className="pd-namelink tr-pname" href={`/player/${p.id}`}>
        {p.name ?? p.webName ?? "?"}
      </Link>
      <span className="tr-pos">{p.position ?? "?"}</span>
    </>
  );
}

/** A manager-name link, abbreviated - same convention as the ledger/squads. */
function ManagerMoveLink({ slot, short }: { slot: number; short: string }) {
  return (
    <Link className="pd-namelink" href={`/manager/${slot}`}>
      {abbr(short)}
    </Link>
  );
}

/** One side of a trade: the players (and cash, if any) that side gave up. */
function TradeSide({
  label,
  players,
  cash,
}: {
  label: string;
  players: TradeMovePlayer[];
  cash: number;
}) {
  const nothing = players.length === 0 && cash <= 0;
  return (
    <div className="tr-side">
      <div className="tr-side-lbl">{label}</div>
      {nothing ? (
        <div className="tr-side-empty">nothing</div>
      ) : (
        <ul className="tr-plist">
          {players.map((p) => (
            <li className="tr-prow" key={p.id}>
              <PlayerMoveLink p={p} />
            </li>
          ))}
          {cash > 0 && <li className="tr-prow tr-cash">{money(cash)}</li>}
        </ul>
      )}
    </div>
  );
}

function TradeCard({ trade }: { trade: TradeRow }) {
  const when = new Date(trade.createdAt).toLocaleString();
  return (
    <div className="tr-card" data-testid={`trade-${trade.id}`}>
      <div className="tr-card-head">
        <div className="tr-matchup">
          <ManagerMoveLink slot={trade.managerA.slot} short={trade.managerA.short} />
          <span className="tr-vs" aria-hidden>&harr;</span>
          <ManagerMoveLink slot={trade.managerB.slot} short={trade.managerB.short} />
        </div>
        <div className="tr-card-meta">
          <span className="tr-stage">{trade.stage}</span>
          <span className="tr-time">{when}</span>
        </div>
      </div>
      <div className="tr-sides">
        <TradeSide
          label={`${abbr(trade.managerA.short)} gives`}
          players={trade.playersAToB}
          cash={trade.cashAToB}
        />
        <TradeSide
          label={`${abbr(trade.managerB.short)} gives`}
          players={trade.playersBToA}
          cash={trade.cashBToA}
        />
      </div>
    </div>
  );
}

export default function TradesView() {
  const [payload, setPayload] = useState<TradesPayload | null>(null);
  const [error, setError] = useState(false);
  const isPhone = useIsPhone();

  async function load() {
    setError(false);
    try {
      const res = await fetch("/api/trades", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setPayload((await res.json()) as TradesPayload);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error && payload == null) {
    return (
      <div className="tr-screen" data-testid="trades-page">
        <div className="tr-loading">
          trades unavailable - <button className="tr-refresh" onClick={load}>retry</button>
        </div>
        {isPhone && <PhoneNav />}
      </div>
    );
  }
  if (payload == null) {
    return (
      <div className="tr-screen" data-testid="trades-page">
        <div className="tr-loading">loading the trades...</div>
        {isPhone && <PhoneNav />}
      </div>
    );
  }

  return (
    <div className="tr-screen" data-testid="trades-page">
      <header className="tr-head">
        <div>
          <div className="tr-eyebrow">TRADES</div>
          <h1 className="tr-title">Trade log</h1>
        </div>
        <div className="tr-head-right">
          <span className="tr-count" data-testid="trades-count">
            {payload.count} trade{payload.count === 1 ? "" : "s"}
          </span>
          <button className="tr-refresh" onClick={load}>refresh</button>
        </div>
      </header>

      {payload.count === 0 ? (
        <div className="tr-empty" data-testid="trades-empty">No trades yet.</div>
      ) : (
        <div className="tr-list">
          {payload.trades.map((t) => (
            <TradeCard key={t.id} trade={t} />
          ))}
        </div>
      )}

      <footer className="tr-foot">
        <Link href="/">&larr; Back to the board</Link>
      </footer>

      {isPhone && <PhoneNav />}
    </div>
  );
}
