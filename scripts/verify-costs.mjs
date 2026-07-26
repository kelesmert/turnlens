// Re-derives the cost of every row in a session CSV and compares it with what
// TurnScope recorded.
//
// Run: npm run build && node scripts/verify-costs.mjs [path/to/session.csv]
// With no argument, the most recently modified CSV under turnscope-usage/ is used.
//
// Two design decisions make this a real check rather than a tautology.
//
// The arithmetic here is written out independently instead of calling
// `computeTurnCost`. Importing the function under test would only assert that it
// equals itself; the point is that a second, separately written implementation
// reaches the same number.
//
// The rates, by contrast, are looked up rather than hardcoded. A verification
// snippet with fixed rates is unsafe by construction: the first version of this
// check hardcoded gpt-5.6-sol's rates, and when a real session used
// gpt-5.6-luna -- which is exactly one fifth of sol in every rate -- it reported
// every row as a 5x mismatch. The product was right and the check was wrong.
//
// A row also records which pricing document paid for it. If the local data no
// longer matches that version, this reports the row as unverifiable rather than
// as a mismatch, because a rate that legitimately changed upstream is not a bug.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCsvRow, CSV_HEADER } from "../dist/core/store/csv.js";
import { createPricingResolver } from "../dist/pricing/resolver.js";

const OUTPUT_DIR = "turnscope-usage";

const path = process.argv[2] ?? (await mostRecentCsv());
if (path === undefined) {
  console.error(`No CSV given and none found under ${OUTPUT_DIR}/.`);
  process.exit(1);
}

const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
const rows = lines.slice(1).map(parseCsvRow);
if (rows.length === 0) {
  console.error(`${path} has no recorded turns.`);
  process.exit(1);
}

// Offline: verification must never depend on the network, and a fetch here could
// pull rates newer than the ones that priced these rows.
const pricing = await createPricingResolver({
  offline: true,
  cachePath: join(homedir(), ".turnscope", "pricing", "litellm.json"),
});

console.log(`file    : ${path}`);
console.log(`rows    : ${rows.length}`);
console.log(`checking against local pricing data\n`);

let matched = 0;
let mismatched = 0;
let unverifiable = 0;
let total = 0;

for (const fields of rows) {
  const read = (column) => fields[CSV_HEADER.indexOf(column)] ?? "";
  const turn = read("turn_number");
  const model = read("model");
  const recorded = read("estimated_cost_usd");
  const status = read("cost_status");
  const version = read("pricing_version");

  if (recorded === "") {
    console.log(`turn ${turn}  ${model}  no cost recorded (${status})`);
    unverifiable += 1;
    continue;
  }
  total += Number(recorded);

  const lookup = pricing.lookup(model);
  if (lookup.pricing === undefined) {
    console.log(`turn ${turn}  ${model}  UNVERIFIABLE: no local rates for this model`);
    unverifiable += 1;
    continue;
  }
  if (lookup.version !== version) {
    console.log(
      `turn ${turn}  ${model}  UNVERIFIABLE: priced with ${version}, local data is ${lookup.version}`,
    );
    unverifiable += 1;
    continue;
  }

  const expected = recompute(read, lookup.pricing);
  if (expected === undefined) {
    console.log(`turn ${turn}  ${model}  UNVERIFIABLE: a used component has no rate`);
    unverifiable += 1;
    continue;
  }

  // The CSV stores the cost rounded to six decimals, so the recorded value is
  // correct exactly when it is this figure rounded the same way. Comparing with
  // a `< 5e-7` tolerance instead rejects the boundary case: a real turn costing
  // 0.2653995 is stored as 0.265400, which is off by exactly 5e-7 and was
  // reported as a mismatch while printing two identical-looking numbers.
  const ok = expected.toFixed(6) === Number(recorded).toFixed(6);
  if (ok) matched += 1;
  else mismatched += 1;
  console.log(
    `turn ${turn}  ${model}  recorded ${recorded}  expected ${expected.toFixed(6)}  ${ok ? "ok" : "MISMATCH"}`,
  );
}

console.log(`\nmatched      : ${matched}`);
console.log(`mismatched   : ${mismatched}`);
console.log(`unverifiable : ${unverifiable}`);
console.log(`total cost   : $${total.toFixed(6)}`);
process.exit(mismatched === 0 ? 0 : 1);

/**
 * The cost arithmetic, written out on purpose.
 *
 * Mirrors the rules rather than the code: reasoning is part of output and is
 * never billed again, a one-hour cache write falls back to the standard write
 * rate, and a component with usage but no rate makes the row unpriceable.
 */
function recompute(read, rates) {
  const components = [
    [Number(read("input_uncached")), rates.inputPerToken],
    [Number(read("output_including_reasoning")), rates.outputPerToken],
    [Number(read("cache_read")), rates.cacheReadPerToken],
    [Number(read("cache_creation_5m")), rates.cacheCreationPerToken],
    [Number(read("cache_creation_1h")), rates.cacheCreation1hPerToken ?? rates.cacheCreationPerToken],
  ];

  let amount = 0;
  for (const [tokens, rate] of components) {
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    if (rate === undefined) return undefined;
    amount += tokens * rate;
  }
  return amount;
}

async function mostRecentCsv() {
  let entries;
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    return undefined;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith(".csv")) continue;
    const full = join(OUTPUT_DIR, entry);
    candidates.push({ full, mtimeMs: (await stat(full)).mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.full;
}
