"use client";

// The manager profile (#54): a read-only, responsive page for one manager's
// spend and squad - reached from squad cells, the board's manager strip, and
// the ledger's owner link. Unlike the player spotlight (#51), this rides the
// same live poll as squads/ledger (usePolledPlayers, ~2s), so the numbers
// stay current if opened during the room.
//
// This is a profile page, not the scaled 1600x900 TV canvas: one centered,
// readable layout that works on desktop and phone (CSS handles the narrow
// case; no useIsPhone fork). No PhoneNav - it is not one of the tabbed
// room-facing screens.
//
// SEALING: this page only ever iterates a manager's OWNED player ids
// (m.squadPlayerIds), and those are sold by construction - value/verdict are
// already unsealed on their PlayerRow (see lib/players.ts). Nothing new is
// fetched or exposed here for an unsold player.

import Link from "next/link";
import { useParams } from "next/navigation";
import type { Position } from "@/lib/config";
import type { PlayerRow } from "@/lib/players";
import { abbr, clubDot, money, usePolledPlayers, verdictPill } from "@/components/tv-common";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

/** Verdict -> the CSS var that colours the paid-price figure, matching SquadsView. */
function priceColorVar(v: PlayerRow["verdict"]): string {
  if (v === "STEAL") return "var(--vg)";
  if (v === "OVERPAY") return "var(--vb)";
  if (v === "FAIR") return "var(--vf)";
  return "var(--ink)";
}

/** claudeDelta -> pill class (up/down/flat), same convention as squads/board. */
function deltaPillClass(delta: number | null): string {
  if (delta == null) return "flat";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}
function deltaLabel(delta: number | null): string {
  if (delta == null) return "-";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}$${Math.abs(delta).toLocaleString()}`;
}

function BackLink() {
  return (
    <Link href="/squads" className="pd-back md-back">
      &larr; Squads
    </Link>
  );
}

export default function ManagerDetailPage() {
  const params = useParams<{ slot: string }>();
  const slotNum = Number(params?.slot);
  const validSlot = Number.isInteger(slotNum) && slotNum > 0;
  const { payload } = usePolledPlayers();

  if (!validSlot) {
    return (
      <div className="md-msg" data-testid="manager-page">
        <BackLink />
        <div className="md-msg-body">Manager not found.</div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="md-msg" data-testid="manager-page">
        <BackLink />
        <div className="md-msg-body">loading...</div>
      </div>
    );
  }

  const manager = payload.managers.find((m) => m.slot === slotNum);
  if (!manager) {
    return (
      <div className="md-msg" data-testid="manager-page">
        <BackLink />
        <div className="md-msg-body">Manager not found.</div>
      </div>
    );
  }

  const byId = new Map<number, PlayerRow>(payload.players.map((p) => [p.id, p]));
  const owned = manager.squadPlayerIds.map((id) => byId.get(id)).filter((p): p is PlayerRow => p != null);
  const squadSize = Object.values(payload.squad).reduce((a, b) => a + b, 0);

  const groups = POSITIONS.map((pos) => ({
    pos,
    quota: payload.squad[pos] ?? 0,
    players: owned.filter((p) => p.position === pos).sort((a, b) => (b.price ?? 0) - (a.price ?? 0)),
  }));

  return (
    <div className="md-page" data-testid="manager-page">
      <div className="md-inner">
        <BackLink />

        <div className="md-header">
          <span className="md-eyebrow">MANAGER</span>
          <div className="md-name" data-testid="md-name">{abbr(manager.short)}</div>
          <div className="md-sub">
            <span>Slot {manager.slot}</span>
            <span>{owned.length}/{squadSize}</span>
            {manager.squadComplete && <span className="pill md-complete">Complete</span>}
          </div>
        </div>

        <div className="md-tiles">
          <div className="md-tile"><div className="k">Spent</div><div className="v">{money(manager.spent)}</div></div>
          <div className="md-tile"><div className="k">Remaining</div><div className="v">{money(manager.remaining)}</div></div>
          <div className="md-tile"><div className="k">Max bid</div><div className="v">{money(manager.maxBid)}</div></div>
          <div className="md-tile"><div className="k">Open slots</div><div className="v">{manager.openSlots}</div></div>
        </div>

        <div className="md-valrow">
          <span className="lbl">Claude value</span>
          {manager.claudeValue == null ? (
            // Squad players are all sold, so a missing total means the valuation
            // batch is incomplete - "pending", never "sealed" (that implies unsold).
            <span className="v pending">pending</span>
          ) : (
            <span className="v">{money(manager.claudeValue)}</span>
          )}
          <span className={`pill ${deltaPillClass(manager.claudeDelta)}`}>{deltaLabel(manager.claudeDelta)}</span>
        </div>

        {groups.map((g) => (
          <div className="md-group" key={g.pos}>
            <div className="md-grouphead">{g.pos} {g.players.length}/{g.quota}</div>
            {g.players.length === 0 ? (
              <div className="md-row" style={{ color: "var(--muted)" }}>none yet</div>
            ) : (
              g.players.map((p) => (
                <Link key={p.id} href={`/player/${p.id}`} className="md-row" data-testid={`md-player-${p.id}`}>
                  <span className="md-cdot" style={{ background: clubDot(p.teamShort) }} />
                  <span className="md-pname">{p.displayName ?? p.name ?? "?"}</span>
                  <span className="md-tier">T{p.tier ?? "?"}</span>
                  <span className="md-price" style={{ color: priceColorVar(p.verdict) }}>{money(p.price)}</span>
                  <span className="md-value">{p.value == null ? "pending" : money(p.value)}</span>
                  {p.verdict && <span className={`pill ${verdictPill(p.verdict)}`}>{p.verdict}</span>}
                </Link>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
