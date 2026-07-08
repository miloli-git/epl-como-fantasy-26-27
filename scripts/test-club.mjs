// Unit tests for lib/club-core.mjs (pure colour derivation, no DB).
// Run: node scripts/test-club.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { clubWash, darken, tint, washForClub } from "../lib/club-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clubMap = JSON.parse(readFileSync(join(root, "lib", "club-colors.json"), "utf8"));

let failed = false;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failed = true;
}

// darken/tint against hand-computed values for Arsenal red (#EF0107)
eq("darken #EF0107 by .62 -> band bottom", darken("#EF0107", 0.62), "#5b0003");
eq("darken #EF0107 by .45 -> photo ground", darken("#EF0107", 0.45), "#830104");
eq("tint #EF0107 at 12% -> light chip", tint("#EF0107", 0.12), "#fde1e1");
eq("darken to black at amount 1", darken("#EF0107", 1), "#000000");
eq("tint at ratio 0 is white", tint("#EF0107", 0), "#ffffff");

// clubWash assembles every surface for Arsenal
{
  const w = clubWash(clubMap.clubs.ARS);
  eq("ARS bandFrom is primary", w.bandFrom, "#EF0107");
  eq("ARS bandTo darkened", w.bandTo, "#5b0003");
  eq("ARS photoGround", w.photoGround, "#830104");
  eq("ARS chip", w.chip, "#fde1e1");
  eq("ARS text on band", w.text, "#FFFFFF");
  eq("ARS sub = secondary (not white)", w.sub, "#9C824A");
}

// white secondary falls back to soft grey (Everton s = #FFFFFF)
eq("EVE white secondary -> #D9D9D5 sub", clubWash(clubMap.clubs.EVE).sub, "#D9D9D5");

// dark-text exceptions keep their authored text token (WOL, MCI)
eq("WOL dark text token preserved", clubWash(clubMap.clubs.WOL).text, "#231F20");
eq("MCI dark text token preserved", clubWash(clubMap.clubs.MCI).text, "#0D2B4E");

// washForClub lookup by FPL short_name, with graceful null fallback
{
  const ars = washForClub(clubMap, "ARS");
  eq("washForClub ARS carries code + name", [ars.code, ars.name], [3, "Arsenal"]);
  eq("washForClub unknown club -> null", washForClub(clubMap, "XXX"), null);
  eq("washForClub null short -> null", washForClub(clubMap, null), null);
}

// every club in the map produces a full wash without throwing
{
  let ok = true;
  for (const short of Object.keys(clubMap.clubs)) {
    const w = washForClub(clubMap, short);
    if (!w || !w.bandTo || !w.photoGround || !w.chip) ok = false;
  }
  eq("all 20 clubs derive a full wash", ok, true);
}

process.exit(failed ? 1 : 0);
