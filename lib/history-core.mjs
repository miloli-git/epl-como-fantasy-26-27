// Pure parsing for the historical per-season dataset (#60/#61). Turns a
// Vaastav/Fantasy-Premier-League `players_raw.csv` into normalized history rows.
// No DB, no network, no fs - the ingest script (scripts/ingest-history.mjs)
// fetches the CSV text and the DB write; this file is the pure, testable middle
// (scripts/test-history.mjs drives it directly). Plain JS with JSDoc types.
//
// N/A CONTRACT: a column that does not exist in a season's CSV (expected_* before
// 2022-23, defensive_contribution before 2025-26) maps to null = N/A. An empty
// cell also maps to null. A player simply absent from a season has no row at all
// (the payload renders that season as "Not in FPL", which is distinct from N/A).

import { FPL_POSITION } from "./config-core.mjs";

/** @typedef {"GK"|"DEF"|"MID"|"FWD"} Position */

/**
 * Parse CSV text into an array of row objects keyed by header name. Handles
 * double-quoted fields (including embedded commas, quotes and newlines) so a
 * name like "Smith, Jr" never shifts the columns. Returns [] for empty input.
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  if (!text) return [];
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let field = [];
  let cur = "";
  let row = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // swallow; \r\n handled by the \n branch
    } else {
      cur += c;
    }
  }
  // Trailing field/row if the file does not end in a newline.
  if (cur !== "" || row.length > 0) pushRow();
  void field;
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    /** @type {Record<string, string>} */
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

/** Integer for a column, or null when the column is absent/empty/unparseable (N/A). */
function intOf(raw, key) {
  if (!(key in raw)) return null;
  const v = String(raw[key]).trim();
  if (v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Rounded-to-2dp number for a column, or null when absent/empty/unparseable (N/A). */
function numOf(raw, key) {
  if (!(key in raw)) return null;
  const v = String(raw[key]).trim();
  if (v === "") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Vaastav column -> our field. Left = source header, right = normalized key.
// Counts are always present in the supported seasons; expected_* and
// defensive_contribution are absent in older seasons and map to null (N/A).
const COUNT_MAP = {
  total_points: "totalPoints",
  minutes: "minutes",
  starts: "starts",
  goals_scored: "goals",
  assists: "assists",
  clean_sheets: "cleanSheets",
  goals_conceded: "goalsConceded",
  saves: "saves",
  penalties_saved: "pensSaved",
  penalties_missed: "pensMissed",
  bonus: "bonus",
  yellow_cards: "yellows",
  red_cards: "reds",
  own_goals: "ownGoals",
  defensive_contribution: "defContribution",
};
const NUM_MAP = {
  expected_goals: "xg",
  expected_assists: "xa",
  expected_goal_involvements: "xgi",
  expected_goals_conceded: "xgc",
  influence: "influence",
  creativity: "creativity",
  threat: "threat",
  ict_index: "ictIndex",
};

/**
 * Normalize one raw CSV row into a history row for `season`. Returns null when
 * the row has no usable FPL `code` (the stable join key) - such rows are skipped.
 *
 * @param {Record<string, string>} raw
 * @param {string} season  e.g. "2024-25"
 * @returns {(Record<string, unknown>) | null}
 */
export function mapHistoryRow(raw, season) {
  const code = intOf(raw, "code");
  if (code == null) return null;
  const et = intOf(raw, "element_type");
  /** @type {Record<string, unknown>} */
  const out = {
    code,
    season,
    position: (et != null && FPL_POSITION[et]) || null,
  };
  for (const [src, key] of Object.entries(COUNT_MAP)) out[key] = intOf(raw, src);
  for (const [src, key] of Object.entries(NUM_MAP)) out[key] = numOf(raw, src);
  return out;
}

/**
 * Parse a whole season CSV into normalized history rows (code-bearing rows only).
 *
 * @param {string} csvText
 * @param {string} season
 * @returns {Array<Record<string, unknown>>}
 */
export function mapSeasonCsv(csvText, season) {
  return parseCsv(csvText)
    .map((raw) => mapHistoryRow(raw, season))
    .filter((r) => r != null);
}
