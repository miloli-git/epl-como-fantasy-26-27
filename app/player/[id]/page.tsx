"use client";

// The read-only player spotlight behind a ledger click (#51). It reuses the
// board's "on the block" card - club-washed band + bio + big portrait + plate
// (.b-band/.b-bio/.b-photo/.b-plate) and the centre spotlight (points, ranks,
// stat tiles, prior Como owner, morning brief) - but STRIPS every live bidding
// concern (no opening bid, no max-bids, no manager strip, no sold rail, no
// pool/scarcity, no reveal). A SOLD player additionally gets a sale-result
// strip (owner, price, verdict, now-unsealed value) - confirmed with the owner.
//
// SEALING: this page can only render a value it is given. The API
// (lib/player-detail-core.mjs) withholds the sealed valuation STRUCTURALLY for
// an unsold player - it never reaches `payload.sale` (which is null) and never
// rides on `payload.player`. There is nothing to hide with CSS here.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import clubColors from "@/lib/club-colors.json";
import { washForClub } from "@/lib/club-core.mjs";
import type { PlayerDetailPayload } from "@/lib/player-detail";
import {
  PL_KIT,
  PL_PHOTO,
  SILHOUETTE,
  abbr,
  crestErr,
  extraStatEntries,
  money,
  photoErr,
  statTiles,
  useBoardScale,
  useIsPhone,
  verdictPill,
} from "@/components/tv-common";

type Status = "loading" | "ok" | "notfound" | "error";

/** Fetch the single-player payload once (a browse view, not a live board - no
 * polling). Re-fetches only if the id changes. */
function usePlayerDetail(id: string | undefined): { payload: PlayerDetailPayload | null; status: Status } {
  const [payload, setPayload] = useState<PlayerDetailPayload | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    setStatus("loading");
    setPayload(null);
    (async () => {
      try {
        const res = await fetch(`/api/player/${id}`, { cache: "no-store" });
        if (disposed) return;
        if (res.status === 404 || res.status === 400) {
          setStatus("notfound");
          return;
        }
        if (!res.ok) throw new Error(`player ${res.status}`);
        const data = (await res.json()) as PlayerDetailPayload;
        if (disposed) return;
        setPayload(data);
        setStatus("ok");
      } catch {
        if (!disposed) setStatus("error");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [id]);
  return { payload, status };
}

// ---- Phone layout: collapsing club-washed portrait (mirrors PhoneBoard), then
// bio, points/ranks, stat tiles, prior owner, brief, and the sale result. -----

function PhoneDetail({ payload }: { payload: PlayerDetailPayload }) {
  const { player: p, sale } = payload;
  const wash = washForClub(clubColors as never, p.teamShort);
  const tiles = statTiles(p.stats);

  return (
    <div className="ph-screen pd-screen" data-testid="player-page">
      <Link href="/ledger" className="pd-back" data-testid="pd-back">
        &larr; The ledger
      </Link>
      <div className="ph-portrait" style={{ background: wash?.bandFrom ?? "var(--card)" }}>
        <img
          className="ph-portrait-img"
          src={p.code != null ? `/assets/players/250/p${p.code}.png` : SILHOUETTE}
          data-cdn={p.code != null ? `${PL_PHOTO}/photos/players/500x500/${p.code}.png` : undefined}
          alt={p.displayName}
          onError={photoErr}
        />
        <span className="ph-eyebrow ph-portrait-eyebrow">PLAYER</span>
        <div className="ph-portrait-plate">
          <div className="ph-lotname" data-testid="pd-name">{p.displayName}</div>
          <div className="ph-lotmeta">
            {p.teamShort ?? "?"} / {p.position} / T{p.tier ?? "?"}
            {p.fplPrice != null ? ` / FPL £${p.fplPrice}` : ""}
          </div>
        </div>
      </div>

      {sale && (
        <div className="ph-card pd-ph-sale" data-testid="pd-sale">
          <div className="ph-row1">
            <span className="ph-mgr">SOLD &rarr; {abbr(sale.ownerShort)}</span>
            <span className="ph-money-big">{money(sale.price)}</span>
          </div>
          <div className="ph-row2" style={{ borderBottom: "none", paddingBottom: 0 }}>
            <span>Claude value {sale.value == null ? "pending" : money(sale.value)}</span>
            {sale.verdict && (
              <span className={`pill ${verdictPill(sale.verdict)}`}>
                {sale.verdict}{sale.delta != null ? ` ${money(sale.delta)}` : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Unsold: mirror the desktop sealed line (the value is not in the
          payload at all - this is a label about its absence, #51). */}
      {!sale && <div className="ph-card pd-ph-seal">Claude value - sealed until the hammer</div>}

      <div className="ph-sechead">&apos;25 season</div>
      <div className="ph-card">
        <div className="ph-row1">
          <span className="ph-money-big" style={{ fontSize: 40 }}>{p.stats.pts ?? "-"}</span>
          <span className="ph-sub" style={{ textAlign: "right" }}>
            {p.overallRank != null && <div>#{p.overallRank} of all players</div>}
            {p.positionRank != null && <div>#{p.positionRank} in {p.position}</div>}
          </span>
        </div>
        <div className="pd-ph-tiles">
          {tiles.map((t, i) => (
            <div className="pd-ph-tile" key={i}>
              <div className="sv">{t.v}</div>
              <div className="sk">{t.k}</div>
            </div>
          ))}
        </div>
        <div className="pd-ph-extras">
          {extraStatEntries(p.stats, p.position).map((e, i) => (
            <span key={i}><b>{e.v}</b> {e.k}</span>
          ))}
        </div>
      </div>

      <div className="ph-sechead">Bio</div>
      <div className="ph-card">
        <div className="pd-ph-bio">
          <div><div className="bv">{p.age ?? "-"}</div><div className="bk">Age</div></div>
          <div><div className="bv">{p.nationality ?? "-"}</div><div className="bk">Nation</div></div>
          <div><div className="bv">{p.heightCm ?? "-"}</div><div className="bk">CM</div></div>
          <div><div className="bv">{p.position}</div><div className="bk">Pos</div></div>
        </div>
      </div>

      {p.prevComoOwner && (
        <div className="ph-card pd-ph-owner">
          <span className="k">&apos;25 Como owner</span>
          {p.prevComoOwner}{p.prevComoPrice != null ? ` · ${money(p.prevComoPrice)}` : ""}
        </div>
      )}

      {Array.isArray(p.brief) && (p.brief as unknown[]).length > 0 && (
        <>
          <div className="ph-sechead">Morning brief</div>
          <div className="ph-card">
            <ul className="pd-ph-brief">{(p.brief as string[]).map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Desktop: the scaled TV canvas, reusing the board spotlight cells. -------

function DesktopDetail({ payload }: { payload: PlayerDetailPayload }) {
  const { ref, scale } = useBoardScale();
  const { player: p, sale } = payload;
  const wash = washForClub(clubColors as never, p.teamShort);
  const tiles = statTiles(p.stats);
  const ready = scale > 0;

  const clubVars = (wash
    ? { "--cb-from": wash.bandFrom, "--cb-to": wash.bandTo, "--cg": wash.photoGround, "--ct": wash.text, "--cs": wash.sub }
    : {}) as CSSProperties;

  return (
    <div data-testid="player-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>Player</div>
            <div style={{ margin: "10px 0" }}>loading...</div>
          </div>
        ) : (
          <div className="board-canvas detail" style={clubVars}>
            {/* TOP BAR: back link + club */}
            <div className="bcell b-top">
              <Link href="/ledger" className="pd-back" data-testid="pd-back">&larr; The ledger</Link>
              <span className="kick">Player</span>
              <span className="clubname">
                <span className="clubdot" style={{ background: wash?.bandFrom ?? "#888" }} />
                {(wash?.name ?? p.teamShort ?? "").toUpperCase()}
              </span>
              <span className="spacer" />
              <span className="facts">
                Tier <b>{p.tier ?? "?"}</b> · FPL <b>£{p.fplPrice ?? "?"}</b>
                {p.stats.selectedBy != null && <> · owned <b>{p.stats.selectedBy}%</b></>}
              </span>
            </div>

            {/* LEFT: the player */}
            <div className="bcell b-player">
              <div className="b-band">
                {p.teamCode != null && (
                  <img
                    className="b-kit"
                    src={`/assets/kits/t${p.teamCode}.png`}
                    data-cdn={`${PL_KIT}/shirt_${p.teamCode}-110.png`}
                    alt=""
                    onError={crestErr}
                  />
                )}
                <div className="b-band-txt">
                  <div className="club">{wash?.name ?? p.teamShort ?? ""}</div>
                  {wash?.nick && <div className="clubsub">{wash.nick} · {wash.stadium}</div>}
                </div>
              </div>
              <div className="b-bio">
                <div><div className="bv">{p.age ?? "-"}</div><div className="bk">Age</div></div>
                <div><div className="bv">{p.nationality ?? "-"}</div><div className="bk">Nation</div></div>
                <div><div className="bv">{p.heightCm ?? "-"}</div><div className="bk">CM</div></div>
                <div><div className="bv">{p.position}</div><div className="bk">Pos</div></div>
              </div>
              <div className="b-photo">
                <img
                  src={p.code != null ? `/assets/players/250/p${p.code}.png` : SILHOUETTE}
                  data-cdn={p.code != null ? `${PL_PHOTO}/photos/players/500x500/${p.code}.png` : undefined}
                  alt={p.displayName}
                  onError={photoErr}
                />
                <div className="b-plate">
                  <div className="name" data-testid="pd-name">{p.displayName}</div>
                  <div className="sub">
                    {[p.firstName, p.secondName].filter(Boolean).join(" ") || p.displayName} · {wash?.name ?? p.teamShort}
                  </div>
                </div>
              </div>
            </div>

            {/* CENTER: spotlight */}
            <div className="bcell b-spot">
              <div className="b-spot-head">
                <div className="b-eyebrow">&apos;25 points</div>
                <div className="b-points">
                  <span className="n">{p.stats.pts ?? "-"}</span>
                  <span className="ranks">
                    {p.overallRank != null && <div className="r1">#{p.overallRank} of all players</div>}
                    {p.positionRank != null && <div className="r2">#{p.positionRank} in {p.position}</div>}
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
                <div className="b-extras">
                  {extraStatEntries(p.stats, p.position).map((e, i) => (
                    <span key={i}><b>{e.v}</b> {e.k}</span>
                  ))}
                </div>
                {p.prevComoOwner && (
                  <div className="b-owner">
                    <span className="k">&apos;25 Como owner</span>
                    {p.prevComoOwner}{p.prevComoPrice != null ? ` · ${money(p.prevComoPrice)}` : ""}
                  </div>
                )}
                {Array.isArray(p.brief) && (p.brief as unknown[]).length > 0 && (
                  <div className="b-brief">
                    <span className="k">Morning brief</span>
                    <ul>{(p.brief as string[]).map((b, i) => <li key={i}>{b}</li>)}</ul>
                  </div>
                )}
                <span className="spacer" />
                {/* Unsold: the value stays sealed (and is not even in the payload).
                    Sold: the sale strip below carries the now-unsealed value. */}
                {!sale && <div className="b-sealline">Claude value - sealed until the hammer</div>}
              </div>
            </div>

            {/* SALE RESULT (sold only) - the ledger click's "what happened" strip */}
            {sale && (
              <div className="pd-sale" data-testid="pd-sale">
                <span className="pd-sale-owner">SOLD &rarr; {abbr(sale.ownerShort)}</span>
                <span className="pd-sale-price">Paid {money(sale.price)}</span>
                <span className="pd-sale-val">Claude value {sale.value == null ? "pending" : money(sale.value)}</span>
                {sale.verdict && (
                  <span className={`pill ${verdictPill(sale.verdict)}`} style={{ fontSize: 18, padding: "4px 16px" }}>
                    {sale.verdict}{sale.delta != null ? ` ${money(sale.delta)}` : ""}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlayerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const isPhone = useIsPhone();
  const { payload, status } = usePlayerDetail(id);

  if (status === "loading") {
    return (
      <div className="pd-msg" data-testid="player-page">
        <Link href="/ledger" className="pd-back">&larr; The ledger</Link>
        <div className="pd-msg-body">loading...</div>
      </div>
    );
  }
  if (status === "notfound") {
    return (
      <div className="pd-msg" data-testid="player-page">
        <Link href="/ledger" className="pd-back">&larr; The ledger</Link>
        <div className="pd-msg-body">Player not found.</div>
      </div>
    );
  }
  if (status === "error" || !payload) {
    return (
      <div className="pd-msg" data-testid="player-page">
        <Link href="/ledger" className="pd-back">&larr; The ledger</Link>
        <div className="pd-msg-body">Could not load this player - retry from the ledger.</div>
      </div>
    );
  }

  return isPhone ? <PhoneDetail payload={payload} /> : <DesktopDetail payload={payload} />;
}
