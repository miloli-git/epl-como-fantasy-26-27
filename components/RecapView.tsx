"use client";

// The recap (#32/#56): a post-auction summary that sits OUTSIDE the live 2s loop
// (docs/DESIGN.md). It fetches /api/recap once on mount (with a manual refresh)
// and shows: the night's awards (biggest overpay, steal, fastest hammer - derived
// from the ledger), the per-manager leftover money (Y1 = next February's war
// chest), and each manager's FINAL SQUAD doubling as an FPL Draft entry checklist.
//
// Awards degrade gracefully: if no sealed values are in yet, the overpay/steal
// cards say so and the page still shows the war chest and squads. Money is always
// via the shared money() formatter; manager labels via abbr() - same as every
// surface. Player and manager names link to their pages (same convention as the
// ledger/squads): player -> /player/[id], manager -> /manager/[slot].
//
// SEALING: this view only renders what /api/recap gives it. Squad players are all
// sold, so their value/verdict are already unsealed server-side (lib/recap-core.mjs);
// nothing here reads a value for an unsold player.
//
// The FPL entry checklist is a per-DEVICE convenience: which players a manager has
// already entered on draft.premierleague.com is kept in localStorage (no server
// state, no auth - the war-room model). It survives a refresh; it is not shared.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RecapAward, RecapPayload, RecapSquad, RecapSquadPlayer } from "@/lib/recap";
import { abbr, money } from "./tv-common";

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

/** signed money for a delta: "+$240", "-$625", "$0". */
function signedMoney(delta: number): string {
  if (delta === 0) return money(0);
  return `${delta > 0 ? "+" : "-"}${money(Math.abs(delta))}`;
}

/** Verdict -> the CSS var that colours a paid price, matching squads/manager. */
function priceColorVar(v: string | null): string {
  if (v === "STEAL") return "var(--vg)";
  if (v === "OVERPAY") return "var(--vb)";
  if (v === "FAIR") return "var(--vf)";
  return "var(--ink)";
}
/** Verdict -> pill palette class (STEAL up, OVERPAY down, else flat). */
function verdictPillClass(v: string | null): string {
  return v === "STEAL" ? "up" : v === "OVERPAY" ? "down" : "flat";
}

/** A player-name link (recap awards + squad rows). Plain text if no id. */
function PlayerLink({ id, children }: { id: number | null; children: React.ReactNode }) {
  if (id == null) return <>{children}</>;
  return (
    <Link className="pd-namelink" href={`/player/${id}`}>
      {children}
    </Link>
  );
}
/** A manager-name link, abbreviated. Plain text if no slot. */
function ManagerLink({ slot, short }: { slot: number | null; short: string | null }) {
  if (slot == null) return <>{abbr(short)}</>;
  return (
    <Link className="pd-namelink" href={`/manager/${slot}`}>
      {abbr(short)}
    </Link>
  );
}

function OverUnderCard({
  title,
  award,
  valuedCount,
}: {
  title: string;
  award: RecapAward | null;
  valuedCount: number;
}) {
  if (award == null) {
    // Distinguish "no values yet" from "values in, but no sale went this way".
    const msg = valuedCount === 0 ? "no sealed values in yet" : "none this night";
    return (
      <div className="rc-award" data-testid={`award-${title}`}>
        <div className="rc-award-lbl">{title}</div>
        <div className="rc-award-empty">{msg}</div>
      </div>
    );
  }
  const delta = award.delta ?? 0;
  const verdict = delta > 0 ? "OVERPAY" : delta < 0 ? "STEAL" : "FAIR";
  const cls = delta > 0 ? "over" : delta < 0 ? "under" : "fair";
  return (
    <div className="rc-award" data-testid={`award-${title}`}>
      <div className="rc-award-lbl">{title}</div>
      <div className="rc-award-name"><PlayerLink id={award.playerId}>{award.name}</PlayerLink></div>
      <div className="rc-award-owner">&rarr; <ManagerLink slot={award.ownerSlot} short={award.ownerShort} /></div>
      <div className="rc-award-figs">
        <span>paid {money(award.price)}</span>
        <span>value {money(award.value)}</span>
      </div>
      <div className={`rc-award-verdict ${cls}`}>
        {verdict} {signedMoney(delta)}
      </div>
    </div>
  );
}

function FastestCard({ award }: { award: RecapAward | null }) {
  if (award == null) {
    return (
      <div className="rc-award" data-testid="award-fastest">
        <div className="rc-award-lbl">Fastest hammer</div>
        <div className="rc-award-empty">no timed lots yet</div>
      </div>
    );
  }
  return (
    <div className="rc-award" data-testid="award-fastest">
      <div className="rc-award-lbl">Fastest hammer</div>
      <div className="rc-award-name"><PlayerLink id={award.playerId}>{award.name}</PlayerLink></div>
      <div className="rc-award-owner">&rarr; <ManagerLink slot={award.ownerSlot} short={award.ownerShort} /></div>
      <div className="rc-award-figs">
        <span>paid {money(award.price)}</span>
      </div>
      <div className="rc-award-verdict fair">
        {award.seconds ?? 0}s on the block
      </div>
    </div>
  );
}

/**
 * Per-device "entered on FPL Draft" ticks, keyed by season then manager slot.
 * localStorage only - no server state (war-room model). Returns the map, a
 * per-slot toggle, and whether hydration from storage has run (so the persist
 * effect never overwrites saved ticks with an empty initial state).
 */
function useEnteredMap(season: string): {
  entered: Record<number, number[]>;
  toggle: (slot: number, playerId: number) => void;
} {
  const key = `como.recap.${season}.entered`;
  const [entered, setEntered] = useState<Record<number, number[]>>({});

  // Hydrate from storage whenever the season key changes. There is deliberately
  // NO persist effect: a tick is written straight to localStorage inside
  // toggle(), so there is no hydrate-then-persist ordering where the persist
  // effect could clobber saved data with the pre-hydration {} on the render the
  // season first resolves.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      setEntered(raw ? (JSON.parse(raw) as Record<number, number[]>) : {});
    } catch {
      setEntered({});
    }
  }, [key]);

  function toggle(slot: number, playerId: number) {
    // Closes over the current committed `entered` (toggles are click-driven, one
    // per render), computes the next state, then sets AND persists it together.
    const set = new Set(entered[slot] ?? []);
    if (set.has(playerId)) set.delete(playerId);
    else set.add(playerId);
    const next = { ...entered, [slot]: [...set] };
    setEntered(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode / quota - ticks simply do not persist */
    }
  }

  return { entered, toggle };
}

/** One checklist row: the entered-tick, the FPL name (linked), club/tier, price
 *  coloured by verdict, and the value/verdict (or "pending" pre-valuation). */
function SquadPlayerRow({
  p,
  checked,
  onToggle,
}: {
  p: RecapSquadPlayer;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rc-prow" data-testid={`recap-player-${p.id}`}>
      <label className="rc-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Entered ${p.webName ?? p.displayName ?? "player"}`}
        />
      </label>
      <span className="rc-pname">
        <PlayerLink id={p.id}>{p.webName ?? p.displayName ?? "?"}</PlayerLink>
      </span>
      <span className="rc-pmeta">
        {p.teamShort ?? "?"} / T{p.tier ?? "?"}
      </span>
      <span className="rc-pprice" style={{ color: priceColorVar(p.verdict) }}>
        {money(p.price)}
      </span>
      <span className="rc-pval">
        {p.value == null ? (
          <span className="rc-pending">pending</span>
        ) : (
          <span className={`pill ${verdictPillClass(p.verdict)}`}>{p.verdict ?? "-"}</span>
        )}
      </span>
    </div>
  );
}

function SquadCard({
  squad,
  quotas,
  enteredIds,
  onToggle,
  open,
  onToggleOpen,
}: {
  squad: RecapSquad;
  quotas: Record<string, number>;
  enteredIds: number[];
  onToggle: (playerId: number) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const enteredSet = new Set(enteredIds);
  const enteredHere = squad.players.filter((p) => enteredSet.has(p.id)).length;
  const total = squad.players.length;
  const squadSize = Object.values(quotas).reduce((a, b) => a + b, 0);

  return (
    <div className="rc-mcard" data-testid={`recap-squad-${squad.slot}`}>
      <button
        className="rc-msum"
        aria-expanded={open}
        onClick={onToggleOpen}
        data-testid={`recap-squad-toggle-${squad.slot}`}
      >
        <span className="rc-msum-left">
          <span className={`rc-chevron${open ? " open" : ""}`} aria-hidden>&rsaquo;</span>
          <span className="rc-mname">{abbr(squad.short)}</span>
          <span className="rc-msub">{squad.squadCount}/{squadSize} players</span>
        </span>
        <span className="rc-msum-right">
          <span className="rc-mprog" data-testid={`recap-progress-${squad.slot}`}>
            {enteredHere}/{total} entered
          </span>
        </span>
      </button>

      {open && (
        <div className="rc-mbody">
          <div className="rc-mnote">
            Tick each player as you enter it on draft.premierleague.com. Names are the
            official FPL names.
          </div>
          {POSITIONS.map((pos) => {
            const inPos = squad.players.filter((p) => p.position === pos);
            const quota = quotas[pos] ?? 0;
            return (
              <div className="rc-pgroup" key={pos}>
                <div className="rc-pghead">
                  {pos} {inPos.length}/{quota}
                </div>
                {inPos.length === 0 ? (
                  <div className="rc-prow-empty">none</div>
                ) : (
                  inPos.map((p) => (
                    <SquadPlayerRow
                      key={p.id}
                      p={p}
                      checked={enteredSet.has(p.id)}
                      onToggle={() => onToggle(p.id)}
                    />
                  ))
                )}
              </div>
            );
          })}
          {/* Defensive: any player with an unrecognised position still renders
              and stays checkable, so the "x/n entered" total can never count a
              row the manager cannot see. In practice ingest always sets one. */}
          {(() => {
            const known = new Set<string>(POSITIONS);
            const others = squad.players.filter((p) => p.position == null || !known.has(p.position));
            if (others.length === 0) return null;
            return (
              <div className="rc-pgroup">
                <div className="rc-pghead">Other {others.length}</div>
                {others.map((p) => (
                  <SquadPlayerRow
                    key={p.id}
                    p={p}
                    checked={enteredSet.has(p.id)}
                    onToggle={() => onToggle(p.id)}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default function RecapView() {
  const [payload, setPayload] = useState<RecapPayload | null>(null);
  const [error, setError] = useState(false);
  const [openSlots, setOpenSlots] = useState<Set<number>>(new Set());

  async function load() {
    setError(false);
    try {
      const res = await fetch("/api/recap", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setPayload((await res.json()) as RecapPayload);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Season is stable for the page; the hook tolerates the empty first render.
  const { entered, toggle } = useEnteredMap(payload?.season ?? "current");

  if (error && payload == null) {
    return (
      <div className="rc-screen" data-testid="recap-page">
        <div className="rc-loading">recap unavailable - <button className="rc-refresh" onClick={load}>retry</button></div>
      </div>
    );
  }
  if (payload == null) {
    return (
      <div className="rc-screen" data-testid="recap-page">
        <div className="rc-loading">loading the recap...</div>
      </div>
    );
  }

  // War chest ranking: most money banked first (the interesting order for Feb).
  const warchest = payload.managers.slice().sort((a, b) => b.leftover - a.leftover);

  function toggleOpen(slot: number) {
    setOpenSlots((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }
  const allOpen = payload.squads.length > 0 && openSlots.size === payload.squads.length;
  function toggleAll() {
    setOpenSlots(allOpen ? new Set() : new Set(payload!.squads.map((s) => s.slot)));
  }

  return (
    <div className="rc-screen" data-testid="recap-page">
      <header className="rc-head">
        <div>
          <div className="rc-eyebrow">RECAP</div>
          <h1 className="rc-title">Season {payload.season}</h1>
        </div>
        <div className="rc-head-right">
          <span
            className={`rc-badge ${payload.archived ? "on" : "off"}`}
            data-testid="recap-archived"
          >
            {payload.archived ? "archived" : "live - not yet archived"}
          </span>
          <button className="rc-refresh" onClick={load}>refresh</button>
        </div>
      </header>

      <section className="rc-awards" data-testid="recap-awards">
        <OverUnderCard title="Biggest overpay" award={payload.awards.biggestOverpay} valuedCount={payload.valuedCount} />
        <OverUnderCard title="Steal of the night" award={payload.awards.steal} valuedCount={payload.valuedCount} />
        <FastestCard award={payload.awards.fastestHammer} />
      </section>

      <section className="rc-warchest" data-testid="recap-warchest">
        <div className="rc-sechead">
          February war chest <span className="rc-sub">leftover money is a number of record</span>
        </div>
        <table className="rc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Manager</th>
              <th className="num">Spent</th>
              <th className="num">Leftover</th>
              <th className="num">Squad</th>
            </tr>
          </thead>
          <tbody>
            {warchest.map((m, i) => (
              <tr key={m.slot} data-testid={`warchest-${m.slot}`}>
                <td className="rc-rank">{i + 1}</td>
                <td>
                  <Link href={`/manager/${m.slot}`}>{abbr(m.short)}</Link>
                </td>
                <td className="num">{money(m.spent)}</td>
                <td className="num rc-leftover">{money(m.leftover)}</td>
                <td className="num">{m.squadCount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td></td>
              <td>Total</td>
              <td className="num">{money(payload.totalSpent)}</td>
              <td className="num rc-leftover">{money(payload.totalLeftover)}</td>
              <td className="num"></td>
            </tr>
          </tfoot>
        </table>
      </section>

      <section className="rc-squads" data-testid="recap-squads">
        <div className="rc-sechead rc-squads-head">
          <span>
            Final squads and FPL Draft entry{" "}
            <span className="rc-sub">tick players as you enter them on the official site</span>
          </span>
          {payload.squads.length > 0 && (
            <button className="rc-refresh" onClick={toggleAll} data-testid="recap-expand-all">
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
        {payload.squads.map((s) => (
          <SquadCard
            key={s.slot}
            squad={s}
            quotas={payload.squad}
            enteredIds={entered[s.slot] ?? []}
            onToggle={(id) => toggle(s.slot, id)}
            open={openSlots.has(s.slot)}
            onToggleOpen={() => toggleOpen(s.slot)}
          />
        ))}
      </section>

      <section className="rc-actions" data-testid="recap-actions">
        <Link className="rc-actionlink" href="/ledger" data-testid="recap-ledger-link">
          Open the full ledger &rarr;
        </Link>
      </section>

      <footer className="rc-foot">
        <Link href="/">&larr; Back to the board</Link>
      </footer>
    </div>
  );
}
