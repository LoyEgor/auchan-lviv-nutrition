// Cross-store price intelligence: find the same product across stores and tell
// the user where it is cheaper. The dataset's distinguishing feature is that it
// holds both Auchan and Silpo, but on its own that is just a filter; this turns
// it into "this exact item is −18% at Silpo".
//
// Matching is deliberately CONSERVATIVE — a wrong "cheaper at X" hint is worse
// than a missing one — so two products are considered the same item only when:
//   1. both carry the same brand (folded), and
//   2. they fall in the same pack-size bucket (same grams/ml, or both
//      weight-priced), and
//   3. their title token sets (brand/size/marketing words stripped) overlap
//      strongly (Jaccard ≥ THRESHOLD).
// Equivalence is made transitive within a bucket via union-find, then each
// cluster that spans ≥2 stores yields a per-product comparison by price per
// 100 g/ml (the size-independent value metric), so a 180 g vs 200 g pack of the
// same yogurt still compares fairly.

import type { Product, StoreId } from "./types";
import { pricePer100g } from "./lib";
import { fold, tokenize } from "./search/fold";

const JACCARD_THRESHOLD = 0.6;

// "No brand" sentinels both stores use ("без ТМ" / "Без ТМ"). These are NOT a
// real brand — grouping by them would lump unrelated staples (different fish,
// cucumber varieties) together, so brandless products are excluded from
// matching. Cross-store comparison stays trustworthy only on branded packs.
const BRANDLESS = new Set(["без тм", "no name", "noname", "без бренду", "власна марка"].map(fold));

function realBrand(p: Product): string | null {
  if (!p.brand) return null;
  const b = fold(p.brand);
  return BRANDLESS.has(b) ? null : b;
}

// Tokens that say nothing about product identity and only add noise to overlap.
const STOPWORDS = new Set(
  ["та", "і", "з", "зі", "для", "the", "auchan", "ашан", "сільпо", "silpo"].map(fold)
);
const SIZE_TOKEN = /^\d+(?:[.,]\d+)?(?:г|кг|мл|л|шт|%)?$/; // 180г, 1, 2,5, 9%

function packGrams(p: Product): number | null {
  if (p.weight && p.weight > 0) return p.weight;
  if (p.volume && p.volume > 0) return p.volume;
  return null;
}

// Bucket products so only plausibly-identical packs are ever compared.
function sizeKey(p: Product): string | null {
  if (p.unit === "kg" || p.unit === "l") return "bulk";
  const g = packGrams(p);
  return g == null ? null : `g${Math.round(g)}`;
}

// Fat/content percentages are a packaging attribute like size: cottage cheese
// 5% and 9% are different SKUs, so they must land in different buckets and
// never be reported as "the same item, cheaper elsewhere". Folding the % out of
// the title (it tokenizes to a bare number) would otherwise merge them.
function pctKey(p: Product): string {
  const pcts = (p.title.match(/\d+(?:[.,]\d+)?\s*%/g) || [])
    .map((s) => s.replace(/\s|%/g, "").replace(",", "."))
    .sort();
  return pcts.join(",");
}

// A multipack ("10шт", "12г*24шт", "x6") and a single unit can share the same
// per-unit size, so without this they'd bucket together and the pack would look
// many times pricier. Capture the pack count so they never compare.
function packCount(p: Product): string {
  const m =
    p.title.match(/(\d+)\s*шт/) || p.title.match(/[*xх×]\s*(\d+)/) || p.title.match(/(\d+)\s*[*xх×]/);
  return m ? `n${m[1]}` : "";
}

// Same packaged product almost never differs by more than ~2x in per-100g price
// between two local stores; a wider spread inside a matched cluster signals a
// bad match (multipack vs single, mispriced tiny item) — drop the whole cluster.
const MAX_CLUSTER_RATIO = 2;

// Identity tokens: title minus brand, size and stopword tokens.
function titleTokens(p: Product): Set<string> {
  const brandTokens = new Set(p.brand ? tokenize(p.brand) : []);
  const out = new Set<string>();
  for (const t of tokenize(p.title)) {
    if (brandTokens.has(t) || STOPWORDS.has(t) || SIZE_TOKEN.test(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface CrossStoreInfo {
  otherStore: StoreId; // the OTHER store this product is compared against
  otherId: string; // id of the equivalent product in that other store (for the modal)
  deltaPct: number; // how much more THIS product costs vs the other-store equivalent (0 if cheapest)
  isCheapest: boolean; // true when this product is the cheaper (or tied) side
}

interface Node {
  index: number;
  product: Product;
  tokens: Set<string>;
  per100: number | null;
}

// Build id -> CrossStoreInfo for every product that has a confident cheaper (or
// equal-cheapest) equivalent in another store. Products with no cross-store
// match are simply absent from the map.
export function buildCrossStore(products: Product[]): Map<string, CrossStoreInfo> {
  // Group candidates by brand + size; only multi-store buckets can ever match.
  const buckets = new Map<string, Node[]>();
  products.forEach((product, index) => {
    const brandKey = realBrand(product);
    if (!brandKey) return;
    const sk = sizeKey(product);
    if (sk == null) return;
    const key = `${brandKey}|${sk}|${pctKey(product)}|${packCount(product)}`;
    const node: Node = { index, product, tokens: titleTokens(product), per100: pricePer100g(product) };
    const arr = buckets.get(key);
    if (arr) arr.push(node);
    else buckets.set(key, [node]);
  });

  const result = new Map<string, CrossStoreInfo>();

  for (const nodes of buckets.values()) {
    if (nodes.length < 2) continue;
    const stores = new Set(nodes.map((n) => n.product.store));
    if (stores.size < 2) continue; // single-store bucket — nothing to compare

    // Union-find over title-token similarity to cluster equivalent items.
    const parent = nodes.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (jaccard(nodes[i].tokens, nodes[j].tokens) >= JACCARD_THRESHOLD) {
          parent[find(i)] = find(j);
        }
      }
    }

    // Gather clusters.
    const clusters = new Map<number, Node[]>();
    for (let i = 0; i < nodes.length; i++) {
      const root = find(i);
      const arr = clusters.get(root);
      if (arr) arr.push(nodes[i]);
      else clusters.set(root, [nodes[i]]);
    }

    for (const cluster of clusters.values()) {
      const priced = cluster.filter((n) => n.per100 != null);
      const clusterStores = new Set(priced.map((n) => n.product.store));
      if (priced.length < 2 || clusterStores.size < 2) continue;

      // Cheapest NODE per store (keep the product, not just the price), plus the
      // global spread.
      const perStoreMin = new Map<StoreId, Node>();
      let minPer100 = Infinity;
      let maxPer100 = 0;
      for (const n of priced) {
        const v = n.per100 as number;
        if (v < minPer100) minPer100 = v;
        if (v > maxPer100) maxPer100 = v;
        const cur = perStoreMin.get(n.product.store);
        if (!cur || v < (cur.per100 as number)) perStoreMin.set(n.product.store, n);
      }
      // Implausible spread → untrustworthy match; emit nothing for this cluster.
      if (minPer100 <= 0 || maxPer100 / minPer100 > MAX_CLUSTER_RATIO) continue;

      // Each product is compared against the cheapest equivalent in any OTHER
      // store, so the hint (and the modal it opens) always points across stores.
      for (const n of priced) {
        const mine = n.per100 as number;
        let other: Node | null = null;
        for (const m of perStoreMin.values()) {
          if (m.product.store !== n.product.store && (!other || (m.per100 as number) < (other.per100 as number))) other = m;
        }
        if (!other) continue;
        const otherPer100 = other.per100 as number;
        const base = { otherStore: other.product.store, otherId: other.product.id };
        if (mine <= otherPer100) {
          result.set(n.product.id, { ...base, deltaPct: 0, isCheapest: true });
        } else {
          const deltaPct = Math.round(((mine - otherPer100) / otherPer100) * 100);
          result.set(n.product.id, { ...base, deltaPct, isCheapest: false });
        }
      }
    }
  }

  return result;
}
