// Pure unit test for lib/history-core.mjs (#60/#61): CSV parsing + row mapping
// + the N/A contract. No DB, no network - runs anywhere.
import { parseCsv, mapHistoryRow, mapSeasonCsv } from "../lib/history-core.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// --- parseCsv: header keying + quoted fields with embedded commas ---
{
  const csv = 'code,web_name,total_points\n118748,"Salah, M",344\n1,Simple,10\n';
  const rows = parseCsv(csv);
  ok("parseCsv: two data rows", rows.length === 2, `got ${rows.length}`);
  ok("parseCsv: quoted comma keeps columns aligned",
    rows[0].web_name === "Salah, M" && rows[0].total_points === "344",
    JSON.stringify(rows[0]));
  ok("parseCsv: empty input -> []", parseCsv("").length === 0);
}

// --- mapHistoryRow: a MODERN season (has expected_* AND defensive_contribution) ---
{
  const raw = {
    code: "118748", element_type: "3", total_points: "344", minutes: "3200",
    starts: "37", goals_scored: "29", assists: "18", clean_sheets: "12",
    goals_conceded: "40", saves: "0", penalties_saved: "0", penalties_missed: "1",
    bonus: "34", yellow_cards: "2", red_cards: "0", own_goals: "0",
    defensive_contribution: "21",
    expected_goals: "27.5", expected_assists: "11.2", expected_goal_involvements: "38.7",
    expected_goals_conceded: "39.1", influence: "1200.4", creativity: "900.1",
    threat: "1500.9", ict_index: "360.2",
  };
  const m = mapHistoryRow(raw, "2025-26");
  ok("map: code + season + position(MID)", m.code === 118748 && m.season === "2025-26" && m.position === "MID");
  ok("map: counts parsed as ints", m.totalPoints === 344 && m.goals === 29 && m.bonus === 34);
  ok("map: defensive_contribution present in 2025-26", m.defContribution === 21);
  ok("map: expected metrics rounded to 2dp", m.xg === 27.5 && m.xgi === 38.7 && m.ictIndex === 360.2);
}

// --- mapHistoryRow: an OLD season (no expected_*, no defensive_contribution) => N/A nulls ---
{
  const raw = {
    code: "50000", element_type: "1", total_points: "150", minutes: "3420",
    starts: "38", goals_scored: "0", assists: "1", clean_sheets: "14",
    goals_conceded: "35", saves: "110", penalties_saved: "2", penalties_missed: "0",
    bonus: "18", yellow_cards: "3", red_cards: "0", own_goals: "1",
    // no defensive_contribution, no expected_* columns at all
  };
  const m = mapHistoryRow(raw, "2021-22");
  ok("map: GK position", m.position === "GK");
  ok("map: saves/clean sheets counted", m.saves === 110 && m.cleanSheets === 14 && m.pensSaved === 2);
  ok("map: defensive_contribution N/A (null) before 2025-26", m.defContribution === null);
  ok("map: expected metrics N/A (null) before 2022-23",
    m.xg === null && m.xa === null && m.xgi === null && m.xgc === null && m.ictIndex === null);
}

// --- mapHistoryRow: empty cell -> null (N/A), not 0; missing code -> skipped ---
{
  const withBlank = mapHistoryRow({ code: "7", element_type: "4", total_points: "", goals_scored: "5" }, "2023-24");
  ok("map: blank total_points -> null (not 0)", withBlank.totalPoints === null && withBlank.goals === 5);
  const noCode = mapHistoryRow({ element_type: "4", total_points: "9" }, "2023-24");
  ok("map: row without code is skipped (null)", noCode === null);
}

// --- mapSeasonCsv: end to end, drops code-less rows ---
{
  const csv = "code,element_type,total_points,goals_scored\n10,3,100,5\n,3,50,2\n11,2,80,0\n";
  const rows = mapSeasonCsv(csv, "2024-25");
  ok("mapSeasonCsv: keeps only code-bearing rows", rows.length === 2, `got ${rows.length}`);
  ok("mapSeasonCsv: season stamped on every row", rows.every((r) => r.season === "2024-25"));
}

console.log(`\nhistory-core: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
