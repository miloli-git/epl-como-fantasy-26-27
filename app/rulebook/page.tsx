"use client";

// The rulebook (#52): a plain, scrolling rules document for the auction and
// the proposed season economy. This is deliberately NOT the scaled 1600x900
// TV canvas the board/squads/ledger screens use - it is prose, so it reads
// like a page, not a broadcast graphic. No data fetching and no polling: the
// rules are static content, not live room state. Content mirrors docs/PRD.md,
// league.config.json, docs/DATA-MODEL.md, and docs/SEASON-ECONOMY.md; those
// documents are the source of truth if this page and they ever disagree.

import Link from "next/link";
import { PhoneNav, useIsPhone } from "@/components/tv-common";

// ---- Diagrams (inline SVG, tokens only via the .rb-diagram classes in
// globals.css - never a hardcoded fill/stroke here). -------------------------

/** Diagram 1: Phase 1 offers every player once; unsold rolls into Phase 2's
 * nomination rotation, which runs until every squad is full. */
function TwoPhaseDiagram() {
  return (
    <svg className="rb-diagram-svg" viewBox="0 0 760 210" role="img" aria-label="Two-phase auction flow">
      <rect className="rb-box" x="6" y="80" width="92" height="50" rx="8" />
      <text className="rb-label" x="52" y="109" textAnchor="middle">Pool frozen</text>

      <line className="rb-line" x1="98" y1="105" x2="126" y2="105" />
      <polygon className="rb-arrowhead" points="126,100 126,110 134,105" />

      <rect className="rb-box" x="134" y="20" width="224" height="170" rx="10" />
      <text className="rb-kicker" x="246" y="42" textAnchor="middle">PHASE 1</text>
      <text className="rb-label-strong" x="246" y="64" textAnchor="middle">Every player offered once</text>
      <text className="rb-label-mut" x="246" y="80" textAnchor="middle">price order, shuffled within tier</text>
      <line className="rb-line" x1="154" y1="96" x2="338" y2="96" />
      <text className="rb-label" x="246" y="120" textAnchor="middle">bid &rarr; SOLD</text>
      <text className="rb-label" x="246" y="142" textAnchor="middle">no bid &rarr; NO BID</text>
      <text className="rb-label-mut" x="246" y="158" textAnchor="middle">(stays available for Phase 2)</text>
      <text className="rb-label-mut" x="246" y="178" textAnchor="middle">next name known only once a lot closes</text>

      <line className="rb-line" x1="358" y1="105" x2="386" y2="105" />
      <polygon className="rb-arrowhead" points="386,100 386,110 394,105" />
      <text className="rb-label-mut" x="376" y="95" textAnchor="middle">all offered</text>

      <rect className="rb-box" x="394" y="20" width="224" height="170" rx="10" />
      <text className="rb-kicker" x="506" y="42" textAnchor="middle">PHASE 2</text>
      <text className="rb-label-strong" x="506" y="64" textAnchor="middle">Nomination rotation</text>
      <text className="rb-label-mut" x="506" y="80" textAnchor="middle">managers nominate any unsold player</text>
      <text className="rb-label-mut" x="506" y="96" textAnchor="middle">(skipping full squads)</text>
      <text className="rb-label" x="506" y="128" textAnchor="middle">runs until every squad is 15/15</text>

      <line className="rb-line" x1="618" y1="105" x2="646" y2="105" />
      <polygon className="rb-arrowhead" points="646,100 646,110 654,105" />

      <rect className="rb-accentbox" x="654" y="80" width="100" height="50" rx="8" />
      <text className="rb-label-strong" x="704" y="109" textAnchor="middle">15/15</text>
    </svg>
  );
}

/** Diagram 2: the reserve rule as a split bar - remaining budget minus the
 * carved-out reserve leaves the max bid - with the worked example labelled. */
function ReserveRuleDiagram() {
  return (
    <svg className="rb-diagram-svg" viewBox="0 0 760 150" role="img" aria-label="Max-bid reserve rule, worked example">
      <text className="rb-kicker" x="20" y="20">EXAMPLE: $500 REMAINING, 4 OPEN SLOTS (3 OTHER OPEN SLOTS)</text>

      <rect className="rb-chipbox" x="20" y="34" width="518" height="56" rx="10" />
      <text className="rb-label-strong" x="279" y="58" textAnchor="middle">MAX BID</text>
      <text className="rb-label" x="279" y="76" textAnchor="middle">$485</text>

      <rect className="rb-accentbox" x="546" y="34" width="154" height="56" rx="10" />
      <text className="rb-label-strong" x="623" y="58" textAnchor="middle">RESERVE</text>
      <text className="rb-label" x="623" y="76" textAnchor="middle">$15</text>

      <text className="rb-label-mut" x="20" y="112">reserve = minimum opening bid ($5) &times; other open slots (3) = $15</text>
      <text className="rb-label-mut" x="20" y="132">$500 remaining - $15 reserve = $485 max bid</text>
    </svg>
  );
}

/** Diagram 3: the tier ladder - T1 widest and highest opening bid at top,
 * stepping down to T4's league-wide minimum. */
function TierLadderDiagram() {
  const rows = [
    { tier: "T1", band: "FPL price ≥ 12.0", bid: "Opens $50", x: 20, w: 680, accent: true },
    { tier: "T2", band: "FPL price ≥ 9.0", bid: "Opens $25", x: 60, w: 600, accent: false },
    { tier: "T3", band: "FPL price ≥ 7.0", bid: "Opens $10", x: 100, w: 520, accent: false },
    { tier: "T4", band: "everyone else", bid: "Opens $5", x: 140, w: 440, accent: false },
  ];
  return (
    <svg className="rb-diagram-svg" viewBox="0 0 760 280" role="img" aria-label="Tier ladder, opening bids by tier">
      {rows.map((r, i) => {
        const y = 20 + i * 65;
        return (
          <g key={r.tier}>
            <rect className={r.accent ? "rb-accentbox" : "rb-box"} x={r.x} y={y} width={r.w} height="50" rx="8" />
            <text className="rb-kicker" x={r.x + 16} y={y + 30}>{r.tier}</text>
            <text className="rb-label" x={r.x + 56} y={y + 30}>{r.band}</text>
            <text className="rb-label-strong" x={r.x + r.w - 18} y={y + 30} textAnchor="end">{r.bid}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Diagram 4: the provisional season timeline - four spending moments on one
 * wallet that rolls forward, Aug through May. */
function SeasonTimelineDiagram() {
  const stops = [
    { x: 80, month: "AUG", label: "Auction 1", sub: "+$3,000" },
    { x: 290, month: "AUG - JAN", label: "Waiver window 1", sub: "injection (TBC)" },
    { x: 500, month: "FEB", label: "Rebid", sub: "+$2,000" },
    { x: 690, month: "FEB - MAY", label: "Waiver window 2", sub: "injection (TBC)" },
  ] as const;
  return (
    <svg className="rb-diagram-svg" viewBox="0 0 760 200" role="img" aria-label="Provisional season timeline, Aug to May">
      <line className="rb-line" x1="20" y1="70" x2="740" y2="70" />
      {stops.map((s) => (
        <g key={s.label}>
          <text className="rb-label-mut" x={s.x} y="34" textAnchor="middle">{s.month}</text>
          <circle className="rb-tierbar" cx={s.x} cy="70" r="6" />
          <line className="rb-line" x1={s.x} y1="76" x2={s.x} y2="98" />
          <text className="rb-label-strong" x={s.x} y="116" textAnchor="middle">{s.label}</text>
          <text className="rb-label-mut" x={s.x} y="132" textAnchor="middle">{s.sub}</text>
        </g>
      ))}
      <line className="rb-accentline" x1="20" y1="168" x2="712" y2="168" />
      <polygon className="rb-accentarrow" points="712,162 712,174 726,168" />
      <text className="rb-label-mut" x="380" y="190" textAnchor="middle">one wallet rolls forward for the whole season</text>
    </svg>
  );
}

// ---- Page body (shared by the phone and desktop wrappers below). -----------

function RulebookBody() {
  return (
    <>
      <header className="rb-header">
        <span className="rb-eyebrow">EPL COMO FANTASY</span>
        <h1 className="rb-title">Rulebook</h1>
        <p className="rb-subtitle">
          The v1 auction rules below are settled. The season-economy section at the end (v2) is a
          provisional proposal and does not affect the Aug 2 auction.
        </p>
      </header>

      <section className="rb-section">
        <div className="rb-kick">OVERVIEW</div>
        <h2 className="rb-h2">The war-room model</h2>
        <div className="rb-card rb-prose">
          <p>
            EPL Como Fantasy runs the league&apos;s live, in-person auction draft as a single,
            config-driven web tool. One shared page serves the TV in the room, laptops, and phones -
            there are no logins and no private data. Every screen shows only information any manager
            could already work out for themselves: every budget, every live max bid, every squad,
            the remaining player pool, and the full sale log.
          </p>
          <p>
            All screens poll the shared state roughly every 2 seconds. The auctioneer&apos;s console
            is the only screen that writes - everyone else is a read-only mirror of the same room.
          </p>
          <p>
            Season scoring does not live here. Once the auction ends, each manager enters their squad
            on the official FPL Draft site, and the season is scored there.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">THE BASICS</div>
        <h2 className="rb-h2">Budget and squad</h2>
        <div className="rb-card rb-prose">
          <p>
            Eight managers each start the draft with $3,000 of auction money. Each manager must fill
            a 15-player squad: 2 goalkeepers, 5 defenders, 5 midfielders, 3 forwards.
          </p>
          <p>
            None of these numbers are hardcoded. Manager count, budget, and squad shape all come from
            the league configuration - manager count is even derived from the length of the roster
            list. If the league changes any of these before draft day, the tool follows the config.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">HOW THE DRAFT RUNS</div>
        <h2 className="rb-h2">The two-phase auction</h2>
        <div className="rb-card rb-prose">
          <p>
            <strong>Phase 1:</strong> every player is offered exactly once, in order of FPL price from
            highest to lowest, shuffled within each price tier so the order is not fully predictable.
            Bidding happens by voice in the room; the auctioneer records the winning manager and price.
            If nobody bids, the player is marked NO BID and stays available for later - there is no
            ad-hoc re-queuing mid-phase. The room only learns the next player&apos;s name once the
            current lot closes.
          </p>
          <p>
            <strong>Phase 2:</strong> once every player has been offered, the auctioneer triggers
            phase 2. Managers nominate any unsold player - including NO BID players - in a fixed
            rotation, skipping any manager whose squad is already full, until every squad reaches
            15 of 15.
          </p>
          <div className="rb-diagram">
            <TwoPhaseDiagram />
            <div className="rb-diagram-caption">
              Phase 1 offers every player once; anything unsold rolls into Phase 2&apos;s nomination
              rotation.
            </div>
          </div>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">PRICING</div>
        <h2 className="rb-h2">Tiers and opening bids</h2>
        <div className="rb-card rb-prose">
          <p>
            Every player&apos;s tier is set by their FPL price, and each tier carries a minimum
            opening bid. These are the league&apos;s current defaults - all are editable in config:
          </p>
          <table className="rb-table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>FPL price</th>
                <th>Opening bid</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Tier 1</td><td>&ge; 12.0</td><td>$50</td></tr>
              <tr><td>Tier 2</td><td>&ge; 9.0</td><td>$25</td></tr>
              <tr><td>Tier 3</td><td>&ge; 7.0</td><td>$10</td></tr>
              <tr><td>Tier 4</td><td>everyone else</td><td>$5</td></tr>
            </tbody>
          </table>
          <p>
            The lowest tier&apos;s opening bid ($5 by default) is the league-wide minimum opening bid -
            the number the max-bid reserve rule below is built on.
          </p>
          <div className="rb-diagram">
            <TierLadderDiagram />
            <div className="rb-diagram-caption">
              Higher tiers carry higher opening bids; Tier 4 sets the league-wide minimum.
            </div>
          </div>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">RULES OF THE ROOM</div>
        <h2 className="rb-h2">Bidding and validation</h2>
        <div className="rb-card rb-prose">
          <p>
            There is no in-app bidding, no clock, and no per-manager login. Bidding happens verbally
            in the room and the commissioner enters the result. Every recorded sale is still validated
            on the server before it is accepted:
          </p>
          <ul>
            <li>the player is not already owned - ownership is exclusive, one manager per player</li>
            <li>the winning manager has an open slot for that player&apos;s position</li>
            <li>the price is at least the tier&apos;s opening bid</li>
            <li>the price is at most the manager&apos;s max bid</li>
          </ul>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">THE SAFETY NET</div>
        <h2 className="rb-h2">The max-bid reserve rule</h2>
        <div className="rb-card rb-prose">
          <p>
            A manager&apos;s maximum legal bid is their remaining budget minus the minimum opening bid
            multiplied by the number of their OTHER open slots (the slots left after the one they might
            be about to fill). The minimum opening bid is the lowest tier&apos;s opening bid ($5 by
            default).
          </p>
          <p>
            This guarantees every manager can always afford to complete their squad - nobody can bid
            themselves into a corner. It is computed live for all 8 managers and shown everywhere on
            screen.
          </p>
          <div className="rb-diagram">
            <ReserveRuleDiagram />
            <div className="rb-diagram-caption">
              Worked example: a manager with $500 left and 4 open slots (3 OTHER open slots) has a max
              bid of $500 - ($5 &times; 3) = $485.
            </div>
          </div>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">THE REVEAL</div>
        <h2 className="rb-h2">Sealed valuations</h2>
        <div className="rb-card rb-prose">
          <p>
            On the morning of the draft, a fair-price valuation is generated for every player,
            calibrated to the league&apos;s economy. It stays sealed - hidden from everyone, including
            the auctioneer - until the hammer falls. Once a player is sold, the board shows the price
            paid next to the valuation, with a verdict:
          </p>
          <div className="rb-legend">
            <span className="rb-legend-item"><span className="pill up">STEAL</span><span className="rb-legend-label">paid well under value</span></span>
            <span className="rb-legend-item"><span className="pill flat">FAIR</span><span className="rb-legend-label">within $50 of value</span></span>
            <span className="rb-legend-item"><span className="pill down">OVERPAY</span><span className="rb-legend-label">paid well over value</span></span>
          </div>
          <p>
            Sealing is enforced on the server, not just hidden with styling: a sealed valuation never
            appears in any data sent to a browser for a player who has not yet sold.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">IN-AUCTION TRADES</div>
        <h2 className="rb-h2">Trades</h2>
        <div className="rb-card rb-prose">
          <p>
            During a pause in the draft, the auctioneer can enter a trade between two managers -
            players, cash, or both. Salaries travel with the player: trade away a $1,000 player and
            $1,000 of spend moves off your budget and onto theirs, and cash can settle any difference.
          </p>
          <p>
            Trades are guarded: no manager&apos;s budget can go negative, position quotas are
            respected, and no squad can end up over 15 players. Both managers&apos; budgets and max
            bids recalculate instantly, and the board announces the trade.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">FIXING MISTAKES</div>
        <h2 className="rb-h2">Corrections</h2>
        <div className="rb-card rb-prose">
          <p>
            The auctioneer can undo the most recent sale, or edit or void any past sale in the ledger.
            Every correction writes a visible entry to the audit trail, so the room can always see what
            changed and when.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">WRAP-UP</div>
        <h2 className="rb-h2">After the auction</h2>
        <div className="rb-card rb-prose">
          <p>
            Once the draft is done, the tool produces a recap and awards view (biggest overpay, steal
            of the night, and more), a per-manager checklist for entering the squad on the FPL Draft
            site, and a permanent archive of the full ledger.
          </p>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">LOOKING AHEAD</div>
        <h2 className="rb-h2">
          Season economy (v2)
          <span className="rb-provisional">PROVISIONAL</span>
        </h2>
        <div className="rb-card rb-prose">
          <p>
            This section describes a proposed multi-stage model for the whole season - it is not yet
            fully ratified, and nothing here affects the Aug 2 auction. Full detail lives in{" "}
            <code>docs/SEASON-ECONOMY.md</code>.
          </p>
          <p>
            The wallet model: each manager has one wallet for the entire season. Money left unspent at
            any stage rolls forward, and cash injections top the wallet up at fixed points.
          </p>
          <div className="rb-diagram">
            <SeasonTimelineDiagram />
            <div className="rb-diagram-caption">
              Four spending moments on one wallet, Aug through May.
            </div>
          </div>
          <p>Four spending moments:</p>
          <ol>
            <li><strong>Auction one (Aug 2):</strong> start with $3,000, spend it at the auction.</li>
            <li>
              <strong>Waiver window one (Aug - Jan):</strong> a smaller injection (working figure
              $500, to be confirmed) to buy waivers.
            </li>
            <li>
              <strong>Auction two, the rebid (early February, after the real transfer window closes):
              </strong> a $2,000 injection (settled). Each manager may retain any player they own at
              the price they paid in August; every player not retained returns to the pool, and the
              two-phase auction reruns over the released pool. There is no retention cap - a manager
              can retain as many players as their February pot affords. The February pot is
              deliberately smaller than August&apos;s: it rewards bargains and banked money, and taxes
              heavy August spending on a single star.
            </li>
            <li>
              <strong>Waiver window two (Feb - May):</strong> another injection (working figure $500,
              to be confirmed) to buy waivers.
            </li>
          </ol>
          <p>
            Waivers run as sealed-bid mini-auctions: a contested player is put up with a deadline, each
            interested manager submits one sealed maximum, and the highest bid wins. The commissioner
            enters the result - there is no live real-time bidding. Waiver spending draws on the same
            wallet, so it directly reduces February firepower.
          </p>
          <p>
            No carry-over cap: banking money in August to arrive rich in February is an intended,
            rewarded strategy.
          </p>
          <div className="rb-provisional-note">
            Still open - not yet decided:
            <ul>
              <li>the exact waiver injection amounts</li>
              <li>the waiver mini-auction&apos;s opening price, increments, timing, and tie-break rule</li>
              <li>whether a dropped player&apos;s salary is forfeited or partially refunded</li>
              <li>the exact February date</li>
              <li>whether the 2 GK / 5 DEF / 5 MID / 3 FWD roster shape holds through waivers</li>
            </ul>
          </div>
        </div>
      </section>

      <div className="rb-footer">
        This page mirrors docs/PRD.md, league.config.json, docs/DATA-MODEL.md, and
        docs/SEASON-ECONOMY.md - those documents are the source of truth if anything here is unclear.
      </div>
    </>
  );
}

// ---- Wrappers: phone gets .ph-screen (fixed top nav clearance) + PhoneNav;
// desktop gets its own page background and an unobtrusive back-to-board link,
// matching how LedgerView splits its phone/desktop branches. -----------------

export default function RulebookPage() {
  const isPhone = useIsPhone();

  if (isPhone) {
    return (
      <div className="ph-screen" data-testid="rulebook-page">
        <div className="rb-page">
          <RulebookBody />
        </div>
        <PhoneNav />
      </div>
    );
  }

  return (
    <div className="rb-desktop" data-testid="rulebook-page">
      <div className="rb-page">
        <Link href="/" className="rb-backlink">&larr; Board</Link>
        <RulebookBody />
      </div>
    </div>
  );
}
