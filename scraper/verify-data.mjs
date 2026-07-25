// Gate between a finished scrape and publishing: refuses to let a degraded or
// stale snapshot reach the site.
//
// The scrapers swallow per-category failures on purpose (one dead category
// should not kill a whole run), so "exit 0" does NOT mean the catalog is
// complete — a partial store outage silently produces a half-empty snapshot
// that would otherwise be published as if it were today's prices.

import { join } from "node:path";
import { readJsonIfExists, OUT_DIR, RAW_DIR } from "./lib.mjs";

const MAX_AGE_HOURS = Number(process.env.VERIFY_MAX_AGE_HOURS ?? 6);
const MAX_DROP = Number(process.env.VERIFY_MAX_DROP ?? 0.25);

// Absolute floors, ~75% of the steady-state catalog size of each store. Raise
// them if a store's real assortment grows a lot; they only exist to catch a
// collapse, not to track the exact count.
const FLOORS = { auchan: 16000, silpo: 9000 };

const problems = [];
const fail = (msg) => problems.push(msg);
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3_600_000;
// A missing or non-numeric aggregate must fail loudly: `undefined < floor` is
// false, so an absent count would otherwise sail through every threshold below.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// Returns a complaint about a timestamp, or null when it is acceptable. A
// negative age means the stamp is from the future (skewed clock, garbage
// value) — not "extra fresh", but untrustworthy.
function ageProblem(what, age) {
  if (Number.isNaN(age)) return `${what} has no usable generatedAt timestamp`;
  if (age < -0.1) return `${what} is stamped ${(-age).toFixed(1)}h in the future — clock skew or a corrupt value`;
  if (age >= MAX_AGE_HOURS) return `${what} is ${age.toFixed(1)}h old (limit ${MAX_AGE_HOURS}h) — the scrape did not rewrite it`;
  return null;
}

const meta = await readJsonIfExists(join(OUT_DIR, "meta.json"));
const categories = await readJsonIfExists(join(OUT_DIR, "categories.json"));
const products = await readJsonIfExists(join(OUT_DIR, "products.json"));
const lastGood = await readJsonIfExists(join(RAW_DIR, "last-good", "meta.json"));

// The unified category set is ~18 entries; a handful means the store's category
// IDs moved and everything collapsed into the catch-all, which kills the filters
// even though the products themselves look fine.
const MIN_CATEGORIES = 5;

if (!meta) fail("public/data/meta.json is missing or unparseable");
if (!Array.isArray(categories) || categories.length < MIN_CATEGORIES) {
  fail(`categories.json has ${Array.isArray(categories) ? categories.length : 0} categories, expected ≥${MIN_CATEGORIES}`);
}
if (!Array.isArray(products) || products.length === 0) fail("products.json is empty");

if (meta) {
  const stale = ageProblem("snapshot", hoursSince(meta.generatedAt));
  if (stale) fail(stale);
  if (Array.isArray(products) && products.length !== meta.totalKept) {
    fail(`products.json has ${products.length} items but meta says ${meta.totalKept}`);
  }

  for (const [store, floor] of Object.entries(FLOORS)) {
    const snap = meta.stores?.find((s) => s.store === store);
    if (!snap) {
      fail(`store "${store}" is missing from the snapshot`);
      continue;
    }
    const storeStale = ageProblem(`${store} data`, hoursSince(snap.generatedAt));
    if (storeStale) fail(storeStale);

    const kept = num(snap.totalKept);
    const withKcal = num(snap.withKcal);
    const withDiscount = num(snap.withDiscount);
    if (kept == null || withKcal == null || withDiscount == null) {
      fail(`${store}: snapshot aggregates are missing or not numeric`);
      continue;
    }
    if (kept < floor) fail(`${store}: only ${kept} products kept, floor is ${floor}`);
    if (withKcal === 0) fail(`${store}: no product carries nutrition data`);
    if (withDiscount === 0) fail(`${store}: no product carries a discount — promo parsing likely broke`);

    const prev = num(lastGood?.stores?.find((s) => s.store === store)?.totalKept);
    if (prev != null && prev > 0) {
      const drop = 1 - kept / prev;
      if (drop > MAX_DROP) {
        fail(
          `${store}: ${(drop * 100).toFixed(0)}% fewer products than the last good run ` +
            `(${kept} vs ${prev}, limit ${(MAX_DROP * 100).toFixed(0)}%)`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error("[verify] REJECTED — snapshot will not be published:");
  for (const p of problems) console.error(`[verify]  - ${p}`);
  process.exit(1);
}

console.log(
  `[verify] OK — ${meta.totalKept} products, ${meta.stores.map((s) => `${s.store}=${s.totalKept}`).join(" ")}, ` +
    `age ${hoursSince(meta.generatedAt).toFixed(2)}h`,
);
