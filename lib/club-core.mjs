// Pure club-colour derivation for the board's per-lot re-dress (THE HYBRID).
// Three authored tokens per club (p/s/t) live in lib/club-colors.json; every
// other surface derives here so a clash is fixed in the JSON, never in code.
// No fs, no globals - the club map is passed in (or imported by the caller).

/** Parse "#RRGGBB" to [r,g,b] (0-255). Tolerates a leading # or not. */
function toRgb(hex) {
  const h = String(hex).replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** [r,g,b] back to "#rrggbb". */
function toHex([r, g, b]) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Darken toward black by `amount` (0 = unchanged, 1 = black). Mixes each
 * channel with 0: c' = c * (1 - amount). darken("#EF0107", 0.62) keeps 38%.
 * @param {string} hex @param {number} amount @returns {string}
 */
export function darken(hex, amount) {
  const k = 1 - amount;
  return toHex(toRgb(hex).map((c) => c * k));
}

/**
 * A `ratio`-strength tint of `hex` over white (ratio = colour weight): a 12%
 * tint => 12% colour + 88% white, the light-page club chip.
 * @param {string} hex @param {number} ratio @returns {string}
 */
export function tint(hex, ratio) {
  return toHex(toRgb(hex).map((c) => c * ratio + 255 * (1 - ratio)));
}

/** White (or near-white) secondary reads as no-trim; fall back to a soft grey. */
function isWhite(hex) {
  return /^#?f{3}(f{3})?$/i.test(String(hex).replace("#", ""));
}

/**
 * All the derived surfaces for one club, ready to drop into CSS variables.
 * `club` is a {p,s,t} record (one entry from club-colors.json's `clubs`).
 *
 * @param {{p: string, s: string, t: string}} club
 * @returns {{p:string,s:string,t:string,bandFrom:string,bandTo:string,photoGround:string,chip:string,dot:string,sub:string,text:string}}
 */
export function clubWash(club) {
  const { p, s, t } = club;
  return {
    p,
    s,
    t,
    bandFrom: p,
    bandTo: darken(p, 0.62),
    photoGround: darken(p, 0.45),
    chip: tint(p, 0.12),
    dot: p,
    sub: isWhite(s) ? "#D9D9D5" : s,
    text: t,
  };
}

/**
 * Look up a club's wash by FPL team short_name against a loaded club map
 * (the parsed club-colors.json). Returns null for an unknown club so the board
 * can fall back to a neutral (non-washed) treatment rather than throw.
 *
 * @param {{clubs: Record<string, {p:string,s:string,t:string,code:number,name:string}>}} clubMap
 * @param {string | null | undefined} shortName
 */
export function washForClub(clubMap, shortName) {
  if (!shortName) return null;
  const club = clubMap?.clubs?.[shortName];
  return club
    ? { ...clubWash(club), code: club.code, name: club.name, nick: club.nick, stadium: club.stadium }
    : null;
}
