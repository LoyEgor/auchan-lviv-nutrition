// "Healthier alternative" suggestions. The project's validated north star is
// protein density — protein per 100 kcal — which separates satiating real food
// from empty calories. So for a given product this finds same-category items of
// the SAME food family (shared title words) that deliver meaningfully more
// protein per calorie, ranked by relevance then density. Computed on demand
// (one O(n) pass when the user opens the panel), never precomputed for 34k rows.

import type { Product } from "./types";
import { proteinPerKcal, pricePerProtein } from "./lib";
import { tokenize } from "./search/fold";

// Minimum energy so near-zero-calorie items (tea, spices) can't win on density.
const MIN_KCAL = 15;
// A candidate must be at least this much leaner to be worth suggesting.
const DENSITY_GAIN = 1.2;

const STOPWORDS = new Set(["та", "і", "з", "зі", "для", "без", "у", "в", "на"]);
const SIZE_TOKEN = /^\d+(?:[.,]\d+)?(?:г|кг|мл|л|шт|%)?$/;
// Generic descriptors (colour / freshness / size / prep). They are not a food
// family, so matching on them alone wrongly pairs e.g. "картопля молода" with
// "молода капуста" or "перець червоний" with "томат червоний". Dropped by stem.
const MODIFIER_STEM =
  /^(молод|свіж|червон|зелен|жовт|чорн|велик|дрібн|добірн|мит|охолодж|заморож|сушен|варен|відбірн|преміум|premium)/;

// Significant title tokens = food-identity words (brand, size, descriptors out).
function sigTokens(title: string, brand: string | null): Set<string> {
  const brandTokens = new Set(brand ? tokenize(brand) : []);
  const out = new Set<string>();
  for (const t of tokenize(title)) {
    if (brandTokens.has(t) || STOPWORDS.has(t) || SIZE_TOKEN.test(t) || MODIFIER_STEM.test(t)) continue;
    out.add(t);
  }
  return out;
}

export interface Alternative {
  product: Product;
  density: number; // protein per 100 kcal
  cheaper: boolean | null; // vs source by ₴/100g protein; null if not comparable
}

// `storeFilter` mirrors the catalog's store mode: when a single store is
// selected, only that store's products are offered as replacements (it would be
// odd to suggest a Silpo item while browsing Auchan).
export function findHealthier(
  products: Product[],
  source: Product,
  storeFilter: "all" | "auchan" | "silpo" = "all",
  limit = 5
): Alternative[] {
  const srcDensity = proteinPerKcal(source);
  if (srcDensity == null || source.kcal == null) return [];
  const srcTokens = sigTokens(source.title, source.brand);
  if (srcTokens.size === 0) return [];
  const srcPPP = pricePerProtein(source);

  const scored: { alt: Alternative; shared: number }[] = [];
  for (const p of products) {
    if (p.id === source.id || p.cat !== source.cat || !p.inStock) continue;
    if (storeFilter !== "all" && p.store !== storeFilter) continue;
    if (p.kcal == null || p.kcal < MIN_KCAL) continue;
    const d = proteinPerKcal(p);
    if (d == null || d < srcDensity * DENSITY_GAIN) continue;

    const pt = sigTokens(p.title, p.brand);
    let shared = 0;
    for (const t of srcTokens) if (pt.has(t)) shared++;
    if (shared === 0) continue; // different food family — not a real "swap"

    const ppp = pricePerProtein(p);
    const cheaper = ppp != null && srcPPP != null ? ppp <= srcPPP : null;
    scored.push({ alt: { product: p, density: d, cheaper }, shared });
  }

  scored.sort((a, b) => b.shared - a.shared || b.alt.density - a.alt.density);
  return scored.slice(0, limit).map((s) => s.alt);
}

// Existence-only variant of findHealthier's inner predicate: returns true on the
// FIRST qualifying candidate, with no scoring/sort/allocation. `sameCat` is the
// pre-grouped slice of products sharing source.cat, so this never re-scans the
// whole catalog. Drives whether the "healthier swap" button renders.
// MUST stay in lockstep with findHealthier's inner filter (MIN_KCAL,
// DENSITY_GAIN, sigTokens, shared-token rule) or the gate and the modal disagree.
export function hasHealthier(
  source: Product,
  sameCat: Product[],
  storeFilter: "all" | "auchan" | "silpo" = "all"
): boolean {
  const srcDensity = proteinPerKcal(source);
  if (srcDensity == null || source.kcal == null) return false;
  const srcTokens = sigTokens(source.title, source.brand);
  if (srcTokens.size === 0) return false;
  for (const p of sameCat) {
    if (p.id === source.id || !p.inStock) continue;
    if (storeFilter !== "all" && p.store !== storeFilter) continue;
    if (p.kcal == null || p.kcal < MIN_KCAL) continue;
    const d = proteinPerKcal(p);
    if (d == null || d < srcDensity * DENSITY_GAIN) continue;
    const pt = sigTokens(p.title, p.brand);
    for (const t of srcTokens) if (pt.has(t)) return true; // first shared token wins
  }
  return false;
}

// Set of product IDs that have at least one healthier same-family alternative for
// the given store mode. Built once (off the first-paint path): groups by category
// once, then scans only same-category items per product. Store mode is baked in
// because findHealthier (the modal) is store-scoped the same way.
export function buildHasHealthier(
  products: Product[],
  storeFilter: "all" | "auchan" | "silpo" = "all"
): Set<string> {
  const byCat = new Map<string, Product[]>();
  for (const p of products) {
    const bucket = byCat.get(p.cat);
    if (bucket) bucket.push(p);
    else byCat.set(p.cat, [p]);
  }
  const out = new Set<string>();
  for (const p of products) {
    const sameCat = byCat.get(p.cat);
    if (sameCat && hasHealthier(p, sameCat, storeFilter)) out.add(p.id);
  }
  return out;
}
