"use client";

// The recap (#32): a post-auction summary that sits OUTSIDE the live 2s loop
// (docs/DESIGN.md). It fetches /api/recap once on mount (with a manual refresh)
// and shows two things: the night's awards (biggest overpay, steal, fastest
// hammer - derived from the ledger) and the per-manager leftover money (Y1),
// which under the season-economy model (#28) is next February's war chest.
//
// Awards degrade gracefully: if no sealed values are in yet, the overpay/steal
// cards say so and the page still shows the war chest. Money is always via the
// shared money() formatter; manager labels via abbr() - same as every surface.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RecapAward, RecapPayload } from "@/lib/recap";
import { abbr, money } from "./tv-common";

/** signed money for a delta: "+$240", "-$625", "$0". */
function signedMoney(delta: number): string {
  if (delta === 0) return money(0);
  return `${delta > 0 ? "+" : "-"}${money(Math.abs(delta))}`;
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
      <div className="rc-award-name">{award.name}</div>
      <div className="rc-award-owner">&rarr; {abbr(award.ownerShort)}</div>
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
      <div className="rc-award-name">{award.name}</div>
      <div className="rc-award-owner">&rarr; {abbr(award.ownerShort)}</div>
      <div className="rc-award-figs">
        <span>paid {money(award.price)}</span>
      </div>
      <div className="rc-award-verdict fair">
        {award.seconds ?? 0}s on the block
      </div>
    </div>
  );
}

export default function RecapView() {
  const [payload, setPayload] = useState<RecapPayload | null>(null);
  const [error, setError] = useState(false);

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

      <footer className="rc-foot">
        <Link href="/">&larr; Back to the board</Link>
      </footer>
    </div>
  );
}
