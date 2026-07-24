"use client";

// TV verification route - lets the operator page through all 20 Premier
// League clubs on the actual draft-night display before doors open, to
// confirm each club's jersey asset path, band/photo-ground colour wash and
// on-band text contrast render correctly. No live-state poll - this is a
// static confirmation aid, not a board view - but it reuses the exact same
// classes (.b-band/.b-bio/.b-photo/.b-plate) and CSS-variable technique
// (--cb-from/--cb-to/--cg/--ct/--cs) that app/page.tsx feeds from a live
// lot, so a clean pass here is a real check of the board's rendering path,
// just fed with placeholder bio/photo content instead of a live player.
//
// /board/preview            -> gallery of all 20 clubs (data-testid=preview-gallery)
// /board/preview?club=ARS   -> one club filling the screen (data-testid=preview-club)

import { Suspense } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import clubColors from "@/lib/club-colors.json";
import { washForClub } from "@/lib/club-core.mjs";
import { PL_KIT, SILHOUETTE, crestErr } from "@/components/tv-common";

// Club short codes in club-colors.json's key order - both the gallery grid
// and the prev/next cycle on the single-club panel walk this same list, so
// "next" from the last card wraps to the first without a special case.
const CLUB_SHORTS = Object.keys(clubColors.clubs);

/** Kit: local asset first, PL CDN fallback, then hidden on error - the same
 * three-step chain the real board uses for the club jersey (#68), so this route
 * checks the identical asset path (crestErr lives in tv-common.tsx, shared). */
function Kit({ code }: { code: number }) {
  return (
    <img
      src={`/assets/kits/t${code}.png`}
      data-cdn={`${PL_KIT}/shirt_${code}-110.png`}
      alt=""
      onError={crestErr}
    />
  );
}

function swatch(color: string): CSSProperties {
  return {
    display: "inline-block",
    width: 20,
    height: 20,
    borderRadius: 5,
    background: color,
    border: "1px solid rgba(0,0,0,0.15)",
  };
}

function Gallery() {
  return (
    <div data-testid="preview-gallery">
      <h1>Club preview</h1>
      <p>
        All 20 clubs at a glance - band colour, jersey and photo-ground wash. Click a club to fill
        the screen with the same treatment the real board uses for that club&apos;s lot.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 14 }}>
        {CLUB_SHORTS.map((short) => {
          const wash = washForClub(clubColors as never, short);
          if (!wash) return null; // never throw on a malformed row - just skip it
          const bandVars = { ["--cb-from" as string]: wash.bandFrom, ["--ct" as string]: wash.text } as CSSProperties;
          return (
            <a
              key={short}
              href={`/board/preview?club=${short}`}
              style={{ display: "block", borderRadius: 10, overflow: "hidden", boxShadow: "var(--shadow-sm)" }}
            >
              <div className="b-band" style={bandVars}>
                {wash.code != null && <Kit code={wash.code} />}
                <div className="b-band-txt">
                  <div className="club" style={{ fontSize: 20 }}>{wash.name}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", background: "var(--card)" }}>
                <span style={swatch(wash.bandFrom)} title="band" />
                <span style={swatch(wash.photoGround)} title="photo ground" />
                <span style={swatch(wash.sub)} title="sub" />
                <span style={{ marginLeft: "auto", fontWeight: 700, letterSpacing: "0.06em", color: "var(--muted)" }}>
                  {short}
                </span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function UnknownClub({ raw }: { raw: string }) {
  return (
    <div data-testid="preview-unknown">
      <p>Unknown club {raw}</p>
      <a href="/board/preview">Back to gallery</a>
    </div>
  );
}

function ClubPanel({ clubParam }: { clubParam: string }) {
  const key = clubParam.toUpperCase();
  const wash = washForClub(clubColors as never, key);
  if (!wash) return <UnknownClub raw={clubParam} />;

  const idx = CLUB_SHORTS.indexOf(key);
  const prev = CLUB_SHORTS[(idx - 1 + CLUB_SHORTS.length) % CLUB_SHORTS.length];
  const next = CLUB_SHORTS[(idx + 1) % CLUB_SHORTS.length];
  const clubVars = {
    ["--cb-from" as string]: wash.bandFrom,
    ["--cb-to" as string]: wash.bandTo,
    ["--cg" as string]: wash.photoGround,
    ["--ct" as string]: wash.text,
    ["--cs" as string]: wash.sub,
  } as CSSProperties;

  return (
    <div data-testid="preview-club">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <a href="/board/preview">&larr; all clubs</a>
        <span style={{ color: "var(--muted)" }}>{idx + 1} / {CLUB_SHORTS.length}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
          <a href={`/board/preview?club=${prev}`}>&larr; prev</a>
          <a href={`/board/preview?club=${next}`}>next &rarr;</a>
        </span>
      </div>
      <div
        className="b-player"
        style={{ ...clubVars, width: "100%", height: "72vh", borderRadius: 10, overflow: "hidden", boxShadow: "var(--shadow-md)" }}
      >
        <div className="b-band">
          {wash.code != null && <Kit code={wash.code} />}
          <div className="b-band-txt">
            <div className="club">{wash.name}</div>
            {wash.nick && <div className="clubsub">{wash.nick} - {wash.stadium}</div>}
          </div>
        </div>
        <div className="b-bio">
          <div><div className="bv">-</div><div className="bk">Age</div></div>
          <div><div className="bv">-</div><div className="bk">Nation</div></div>
          <div><div className="bv">-</div><div className="bk">CM</div></div>
          <div><div className="bv">FWD</div><div className="bk">Pos</div></div>
        </div>
        <div className="b-photo">
          <img src={SILHOUETTE} alt="Placeholder player photo" />
          <div className="b-plate">
            <div className="name">{wash.name}</div>
            <div className="sub">{wash.nick}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Reads the ?club= param. useSearchParams() needs a Suspense boundary around
// its caller under the App Router (Next 15) even in an all-client-component
// tree, since the page shell is still prerendered - without it, `next build`
// fails with a "missing suspense boundary" error.
function PreviewInner() {
  const searchParams = useSearchParams();
  const clubParam = searchParams.get("club");
  return (
    <main data-testid="board-preview-page" className="screen">
      {clubParam ? <ClubPanel clubParam={clubParam} /> : <Gallery />}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="screen">loading preview...</main>}>
      <PreviewInner />
    </Suspense>
  );
}
