// Plain-node tests for the config merge/validate/derive logic in
// lib/config-core.mjs. No framework, no fixture files on disk - the pure
// buildConfig(base, local?) is tested directly, so we never create or touch
// a real league.config.local.json.
//
// Run: node scripts/test-config.mjs   (exit 0 = all pass, 1 = failures)

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  buildConfig,
  minOpenBid,
  openBidFor,
  selectLocalOverride,
  squadSize,
  tierFor,
} from "../lib/config-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = () =>
  JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assertThrowsNaming(fn, field, label) {
  try {
    fn();
  } catch (err) {
    if (!err.message.includes(field)) {
      throw new Error(
        `${label}: error thrown but message does not name "${field}": ${err.message}`,
      );
    }
    return;
  }
  throw new Error(`${label}: expected an error naming "${field}", none thrown`);
}

// (a) local overrides scalars, replaces arrays wholesale, merges objects
check("local override: budget replaced, managers array replaced wholesale", () => {
  const local = { budget: 5000, managers: ["Alpha", "Beta", "Gamma"] };
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.budget, 5000, "budget");
  assertEqual(cfg.managers, ["Alpha", "Beta", "Gamma"], "managers");
  // untouched keys survive from base
  assertEqual(cfg.season, "26/27", "season");
  assertEqual(cfg.tiers.length, 4, "tiers length");
});

check("local override: nested object merges recursively", () => {
  const cfg = buildConfig(base(), { squad: { FWD: 4 } });
  assertEqual(cfg.squad, { GK: 2, DEF: 5, MID: 5, FWD: 4 }, "squad");
  assertEqual(squadSize(cfg), 16, "squadSize after partial squad override");
});

check("local override does not mutate the base object", () => {
  const b = base();
  buildConfig(b, { budget: 9999, squad: { GK: 3 } });
  assertEqual(b.budget, 3000, "base budget");
  assertEqual(b.squad.GK, 2, "base squad.GK");
});

// (b) absent local returns base values
check("absent local: config equals the base file", () => {
  const cfg = buildConfig(base());
  assertEqual(cfg.budget, 3000, "budget");
  assertEqual(cfg.managers.length, 8, "manager count");
  assertEqual(cfg.managers[0], "Manager 1", "first manager");
  assertEqual(squadSize(cfg), 15, "squad size");
});

// (c) malformed configs throw naming the field
check("malformed: budget -5 throws naming budget", () => {
  assertThrowsNaming(
    () => buildConfig(base(), { budget: -5 }),
    "budget",
    "negative budget",
  );
});

check("malformed: squad missing FWD throws naming FWD", () => {
  const bad = base();
  delete bad.squad.FWD;
  assertThrowsNaming(() => buildConfig(bad), "FWD", "missing FWD");
});

check("malformed: unsorted tiers throw naming tiers", () => {
  const local = {
    tiers: [
      { tier: 1, minFplPrice: 9.0, openBid: 50 },
      { tier: 2, minFplPrice: 12.0, openBid: 25 },
      { tier: 3, minFplPrice: 0, openBid: 5 },
    ],
  };
  assertThrowsNaming(() => buildConfig(base(), local), "tiers", "unsorted tiers");
});

check("malformed: last tier minFplPrice != 0 throws naming minFplPrice", () => {
  const local = {
    tiers: [
      { tier: 1, minFplPrice: 12.0, openBid: 50 },
      { tier: 2, minFplPrice: 7.0, openBid: 25 },
    ],
  };
  assertThrowsNaming(
    () => buildConfig(base(), local),
    "minFplPrice",
    "last band not 0",
  );
});

check("malformed: openBid not descending with tiers throws naming openBid", () => {
  const local = {
    tiers: [
      { tier: 1, minFplPrice: 12.0, openBid: 25 },
      { tier: 2, minFplPrice: 9.0, openBid: 50 },
      { tier: 3, minFplPrice: 0, openBid: 5 },
    ],
  };
  assertThrowsNaming(
    () => buildConfig(base(), local),
    "openBid",
    "non-descending openBid",
  );
});

check("malformed: equal openBid across tiers throws naming openBid", () => {
  const local = {
    tiers: [
      { tier: 1, minFplPrice: 12.0, openBid: 25 },
      { tier: 2, minFplPrice: 9.0, openBid: 25 },
      { tier: 3, minFplPrice: 0, openBid: 5 },
    ],
  };
  assertThrowsNaming(
    () => buildConfig(base(), local),
    "openBid",
    "equal openBid",
  );
});

// (f) prototype-pollution guard in deepMerge
check("deepMerge skips __proto__/constructor/prototype keys", () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "budget": 4000}');
  const cfg = buildConfig(base(), evil);
  assertEqual(cfg.budget, 4000, "budget still merges");
  assertEqual({}.polluted, undefined, "Object.prototype not polluted");
  assertEqual(
    Object.prototype.hasOwnProperty.call(cfg, "__proto__") ? "own" : "absent",
    "absent",
    "__proto__ not copied onto the merged config",
  );
  assertEqual(cfg.polluted, undefined, "merged config has no polluted key");
});

// (g) LEAGUE_CONFIG_LOCAL env-var override (issue #22)
check("env override only: names come from LEAGUE_CONFIG_LOCAL", () => {
  const envText = JSON.stringify({ managers: ["Env A", "Env B"], budget: 4200 });
  const { local, source } = selectLocalOverride({ localFileText: null, envText });
  assertEqual(source, "env", "source");
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.managers, ["Env A", "Env B"], "managers from env");
  assertEqual(cfg.budget, 4200, "budget from env");
});

check("file override only: names come from the local file", () => {
  const localFileText = JSON.stringify({ managers: ["File A", "File B", "File C"] });
  const { local, source } = selectLocalOverride({ localFileText, envText: null });
  assertEqual(source, "file", "source");
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.managers, ["File A", "File B", "File C"], "managers from file");
});

check("both present: the local FILE wins over the env var", () => {
  const localFileText = JSON.stringify({ managers: ["File wins"] });
  const envText = JSON.stringify({ managers: ["Env loses"] });
  const { local, source } = selectLocalOverride({ localFileText, envText });
  assertEqual(source, "file", "source is file");
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.managers, ["File wins"], "file managers win");
});

check("neither present: base placeholders stand", () => {
  const { local, source } = selectLocalOverride({ localFileText: null, envText: null });
  assertEqual(source, "none", "source");
  assertEqual(local, undefined, "no override");
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.managers[0], "Manager 1", "placeholder name");
});

check("blank/whitespace env var is treated as absent, not malformed", () => {
  const { source } = selectLocalOverride({ localFileText: null, envText: "   " });
  assertEqual(source, "none", "whitespace env -> none");
});

check("malformed env JSON fails LOUDLY, naming the env var", () => {
  assertThrowsNaming(
    () => selectLocalOverride({ localFileText: null, envText: "{ not json" }),
    "LEAGUE_CONFIG_LOCAL",
    "malformed env var",
  );
});

check("malformed local FILE fails LOUDLY, naming the file", () => {
  assertThrowsNaming(
    () => selectLocalOverride({ localFileText: "{ not json", envText: null }),
    "league.config.local.json",
    "malformed local file",
  );
});

check("env var that is a JSON array (not an object) fails loudly", () => {
  assertThrowsNaming(
    () => selectLocalOverride({ localFileText: null, envText: "[1,2,3]" }),
    "LEAGUE_CONFIG_LOCAL",
    "env var array",
  );
});

check("a valid file is NOT rejected because the env var is malformed (file wins first)", () => {
  const localFileText = JSON.stringify({ managers: ["File A"] });
  const { local, source } = selectLocalOverride({ localFileText, envText: "{ not json" });
  assertEqual(source, "file", "file short-circuits before the bad env var");
  // ...and the file's roster actually lands (not just the source label).
  const cfg = buildConfig(base(), local);
  assertEqual(cfg.managers, ["File A"], "file managers survive the bad env var");
});

// (d) tierFor with the default bands
check("tierFor: 12.5 -> 1, 9.0 -> 2, 8.9 -> 3, 4.0 -> 4", () => {
  const cfg = buildConfig(base());
  assertEqual(tierFor(cfg, 12.5), 1, "12.5");
  assertEqual(tierFor(cfg, 9.0), 2, "9.0");
  assertEqual(tierFor(cfg, 8.9), 3, "8.9");
  assertEqual(tierFor(cfg, 4.0), 4, "4.0");
});

// (e) minOpenBid + openBidFor
check("minOpenBid is 5 and openBidFor matches each band", () => {
  const cfg = buildConfig(base());
  assertEqual(minOpenBid(cfg), 5, "minOpenBid");
  assertEqual(openBidFor(cfg, 1), 50, "tier 1");
  assertEqual(openBidFor(cfg, 4), 5, "tier 4");
});

if (failures > 0) {
  console.log(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll config tests passed");
