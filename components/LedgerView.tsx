"use client";

// The ledger: every player in the pool, one scrollable table. Sold rows sort
// by paid price (the room's "who got the money" read); unsold rows follow,
// sorted by last season's points. Sealed valuations never appear for unsold
// rows (the API already withholds them structurally - this view just never
// reads `value` for a row where sold is false).

import { useState } from "react";
import type { CSSProperties } from "react";
import type { Position } from "@/lib/config";
import type { PlayerRow, PlayersPayload } from "@/lib/players";
import { PL, PhoneNav, SILHOUETTE, abbr, clubDot, money, photoErr, useBoardScale, useIsPhone, usePolledPlayers } from "./tv-common";

/** Sold rows first (highest paid first), then unsold rows by last season's points. */
function ledgerSort(a: PlayerRow, b: PlayerRow): number {
  if (a.sold !== b.sold) return a.sold ? -1 : 1;
  if (a.sold) return (b.price ?? 0) - (a.price ?? 0);
  return (b.pts ?? 0) - (a.pts ?? 0);
}

function verdictPillClass(v: PlayerRow["verdict"]): string {
  return v === "STEAL" ? "up" : v === "OVERPAY" ? "down" : "flat";
}

function Row({ p }: { p: PlayerRow }) {
  return (
    <tr>
      <td>
        <span className="pcell">
          <img
            className="thumb"
            src={p.code != null ? `/assets/players/110/p${p.code}.png` : SILHOUETTE}
            data-cdn={p.code != null ? `${PL}/photos/players/110x140/p${p.code}.png` : undefined}
            alt=""
            onError={photoErr}
          />
          {p.displayName ?? p.name ?? "?"}
        </span>
      </td>
      <td>
        <span className="cdot" style={{ background: clubDot(p.teamShort) }} />
        {p.teamShort ?? "?"}
      </td>
      <td>{p.position}</td>
      <td>{p.tier ?? "-"}</td>
      <td>{p.fplPrice != null ? `£${p.fplPrice}` : "-"}</td>
      <td>{p.pts ?? "-"}</td>
      <td className={p.ownerShort ? "" : "mut"}>{p.ownerShort ? abbr(p.ownerShort) : "-"}</td>
      <td>{p.sold ? money(p.price) : "-"}</td>
      <td>
        {!p.sold ? (
          // Unsold players never carry a value in this payload (sealed server-side);
          // "sealed" is just the room-facing label for that absence.
          <span className="sealed">sealed</span>
        ) : p.value != null ? (
          money(p.value)
        ) : (
          // Sold but not yet valued (valuation batch incomplete): "pending",
          // matching the board reveal's wording - never a bare "?".
          <span className="mut">pending</span>
        )}
      </td>
      <td>
        {p.sold && p.verdict ? (
          <span className={`pill ${verdictPillClass(p.verdict)}`}>
            {p.verdict}{p.delta != null ? ` ${money(p.delta)}` : ""}
          </span>
        ) : p.noBid ? (
          <span className="nob">NO BID</span>
        ) : null}
      </td>
    </tr>
  );
}

// ---- Phone layout (plain reflowing HTML, not the scaled TV canvas) --------

type PhoneSortKey = "paid" | "points" | "value" | "tier";
type PhonePosFilter = "ALL" | Position;

const PHONE_SORT_OPTIONS: { key: PhoneSortKey; label: string }[] = [
  { key: "paid", label: "Paid" },
  { key: "points", label: "Points" },
  { key: "value", label: "Value" },
  { key: "tier", label: "Tier" },
];
const PHONE_SORT_HEADMETA: Record<PhoneSortKey, string> = {
  paid: "SORTED BY PAID",
  points: "SORTED BY POINTS",
  value: "SORTED BY VALUE",
  tier: "SORTED BY TIER",
};
const PHONE_POSITION_OPTIONS: PhonePosFilter[] = ["ALL", "GK", "DEF", "MID", "FWD"];

/** Paid desc / Points desc / Value desc (nulls last, sealed rows included) / Tier asc. */
function phoneLedgerSort(rows: PlayerRow[], sortKey: PhoneSortKey): PlayerRow[] {
  const out = [...rows];
  switch (sortKey) {
    case "points":
      out.sort((a, b) => (b.pts ?? -Infinity) - (a.pts ?? -Infinity));
      break;
    case "value":
      out.sort((a, b) => {
        if (a.value == null && b.value == null) return 0;
        if (a.value == null) return 1;
        if (b.value == null) return -1;
        return b.value - a.value;
      });
      break;
    case "tier":
      out.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
      break;
    case "paid":
    default:
      out.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  }
  return out;
}

function PhoneLedgerRow({ p }: { p: PlayerRow }) {
  if (!p.sold) {
    // Unsold: sealed - no value/verdict/delta and no paid price, ever. Lighter
    // treatment (opacity, see .ph-ledger-unsold) plus an explicit "unsold" tag.
    return (
      <div className="ph-card ph-ledger-row ph-ledger-unsold" data-testid={`ph-ledger-${p.id}`}>
        <div className="ph-ledger-left">
          <span className="ph-dot" style={{ background: clubDot(p.teamShort) }} />
          <div style={{ minWidth: 0 }}>
            <div className="ph-ledger-name">{p.displayName ?? p.name ?? "?"}</div>
            <div className="ph-sub">
              {p.teamShort ?? "?"} / {p.position} / T{p.tier ?? "?"}
            </div>
          </div>
        </div>
        <div className="ph-ledger-right">
          <span className="ph-sub">unsold</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ph-card ph-ledger-row" data-testid={`ph-ledger-${p.id}`}>
      <div className="ph-ledger-left">
        <span className="ph-dot" style={{ background: clubDot(p.teamShort) }} />
        <div style={{ minWidth: 0 }}>
          <div className="ph-ledger-name">{p.name ?? "?"}</div>
          <div className="ph-sub">
            {p.teamShort ?? "?"} / {p.position} / T{p.tier ?? "?"}
            {p.ownerShort ? ` · ${abbr(p.ownerShort)}` : ""}
          </div>
        </div>
      </div>
      <div className="ph-ledger-right">
        <div className="ph-money-big">{money(p.price)}</div>
        {p.value != null && p.verdict && (
          <span className={`pill ${verdictPillClass(p.verdict)} ph-vpill`}>
            {p.verdict}{p.delta != null ? ` ${money(Math.abs(p.delta))}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function PhoneLedger({ payload, connected }: { payload: PlayersPayload | null; connected: boolean }) {
  const [sortKey, setSortKey] = useState<PhoneSortKey>("paid");
  const [posFilter, setPosFilter] = useState<PhonePosFilter>("ALL");
  const [showAll, setShowAll] = useState(false);

  const ready = payload !== null;
  let rows = payload ? payload.players.filter((p) => showAll || p.sold) : [];
  if (posFilter !== "ALL") rows = rows.filter((p) => p.position === posFilter);
  rows = phoneLedgerSort(rows, sortKey);

  return (
    <div className="ph-screen" data-testid="ledger-page">
      <div className="ph-header">
        <span className="ph-eyebrow">THE LEDGER</span>
        <span className="ph-headmeta">{PHONE_SORT_HEADMETA[sortKey]}</span>
      </div>
      <div className="ph-ctrlwrap">
        <div className="ph-ctrlgroup" role="group" aria-label="Sort ledger by">
          {PHONE_SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`ph-chipbtn${sortKey === o.key ? " active" : ""}`}
              aria-pressed={sortKey === o.key}
              onClick={() => setSortKey(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="ph-ctrlgroup" role="group" aria-label="Filter by position">
          {PHONE_POSITION_OPTIONS.map((pos) => (
            <button
              key={pos}
              type="button"
              className={`ph-chipbtn${posFilter === pos ? " active" : ""}`}
              aria-pressed={posFilter === pos}
              onClick={() => setPosFilter(pos)}
            >
              {pos === "ALL" ? "All" : pos}
            </button>
          ))}
        </div>
        <div className="ph-ctrlgroup" role="group" aria-label="Sold or all players">
          <button
            type="button"
            className={`ph-chipbtn${!showAll ? " active" : ""}`}
            aria-pressed={!showAll}
            onClick={() => setShowAll(false)}
          >
            Sold
          </button>
          <button
            type="button"
            className={`ph-chipbtn${showAll ? " active" : ""}`}
            aria-pressed={showAll}
            onClick={() => setShowAll(true)}
          >
            All
          </button>
        </div>
      </div>
      {!ready ? (
        <div className="ph-loading">{connected ? "connecting..." : "connection lost - retrying"}</div>
      ) : (
        <div className="ph-stack">
          {rows.map((p) => (
            <PhoneLedgerRow key={p.id} p={p} />
          ))}
        </div>
      )}
      <PhoneNav />
    </div>
  );
}

export default function LedgerView() {
  const { payload, connected } = usePolledPlayers();
  const { ref, scale } = useBoardScale();
  const isPhone = useIsPhone();
  if (isPhone) return <PhoneLedger payload={payload} connected={connected} />;
  const ready = payload !== null && scale > 0;

  const rows = payload ? [...payload.players].sort(ledgerSort) : [];

  return (
    <div data-testid="ledger-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>The ledger</div>
            <div style={{ margin: "10px 0" }}>{connected ? "connecting..." : "connection lost - retrying"}</div>
          </div>
        ) : (
          <div className="board-canvas ledger">
            <div className="tv-top">
              <span className="kick">The ledger</span>
              <span className="spacer" />
              <span className="meta">SORTED BY PAID</span>
            </div>
            <div className="ledcell">
              <table className="led">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Club</th>
                    <th>Pos</th>
                    <th>Tier</th>
                    <th>FPL £</th>
                    <th>&apos;25 pts</th>
                    <th>Owner</th>
                    <th>Paid</th>
                    <th>Claude</th>
                    <th>&Delta;</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <Row key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
