// Scraper for a Silpo (Lviv) branch via the public sf-ecom-api.silpo.ua API.
//
// The product list endpoint has prices/discounts but no nutrition facts, so the
// scraper paginates the canonical food top-categories and then fetches each
// product's detail page, where "Харчова цінність на 100 г" lives in
// attributeGroups. Detail results are cached on disk (scraper/raw/) so an
// interrupted or repeated run only fetches what's new. Writes a raw per-store
// snapshot to scraper/raw/silpo.json.
//
// No external deps: relies on Node 18+ global fetch. Run: `node scraper/scrape-silpo.mjs`.

import { join } from "node:path";
import { RAW_DIR, fetchJson, num, pool, sleep, writeJson, readJsonIfExists } from "./lib.mjs";

// "Сільпо" on вул. Під Дубом, 7Б — a large Lviv supermarket with pickup.
const BRANCH_ID = process.env.SILPO_BRANCH_ID || "1edb6b58-cf2f-6c14-b8ca-d11f2666a570";
const BASE = `https://sf-ecom-api.silpo.ua/v1/uk/branches/${BRANCH_ID}`;
const HEADERS = { "Accept-Language": "uk" };
const PAGE = 100;
const LIST_CONCURRENCY = 4;
const DETAIL_CONCURRENCY = 10;
const CACHE_PATH = join(RAW_DIR, "silpo.details-cache.json");

// Canonical food top-categories, by slug with the numeric tail stripped.
// Collection tops (Добрі промо, Власні марки, Лавка Традицій) are skipped: their
// products' own sections root in the canonical trees anyway. Non-food tops
// (household, hygiene, cigarettes, flowers, pharmacy) are skipped entirely.
const FOOD_TOP_KEYS = new Set([
  "frukty-ovochi",
  "m-iaso",
  "ryba",
  "kovbasni-vyroby-i-m-iasni-delikatesy",
  "syry",
  "khlib-ta-vypichka",
  "gotovi-stravy-i-kulinariia",
  "molochni-produkty-ta-iaitsia",
  "bady",
  "zdorove-kharchuvannia",
  "bakaliia-i-konservy",
  "sousy-i-spetsii",
  "solodoshchi",
  "sneky-ta-chypsy",
  "kava-chai",
  "napoi",
  "zamorozhena-produktsiia",
  "alkogol",
  "dlia-tvaryn",
]);

const slugKey = (slug) => String(slug).replace(/-\d+$/, "");

function parseSize(displayRatio, weighted) {
  // Weighted goods (meat, produce…) are priced per kg, like zakaz "kg" goods.
  if (weighted) return { unit: "kg", weight: null, volume: null };
  // Normalize whitespace and all multiplier glyphs (latin x, cyrillic х, ×) to a
  // single "x" so multipack patterns match regardless of which was used.
  const s = String(displayRatio || "").toLowerCase().replace(/\s+/g, "").replace(/[xх×]/g, "x");
  const sized = (n, u) => {
    if (!Number.isFinite(n) || n <= 0) return { unit: "pcs", weight: null, volume: null };
    if (u === "кг") return { unit: "pcs", weight: n * 1000, volume: null };
    if (u === "г") return { unit: "pcs", weight: n, volume: null };
    if (u === "л") return { unit: "pcs", weight: null, volume: n * 1000 };
    return { unit: "pcs", weight: null, volume: n }; // мл
  };
  // Multipacks: "4х90г", "6x50мл" — all x-glyphs normalized to "x" above.
  let m = s.match(/^(\d+)x([\d.,]+)(кг|г|мл|л)/);
  if (m) return sized(parseInt(m[1], 10) * parseFloat(m[2].replace(",", ".")), m[3]);
  m = s.match(/([\d.,]+)(кг|г|мл|л)/);
  if (m) return sized(parseFloat(m[1].replace(",", ".")), m[2]);
  return { unit: "pcs", weight: null, volume: null };
}

// Extract numeric nutrition (per 100 g) from a product detail response.
// Returns null when the product has no nutrition data at all.
function extractNutrition(detail) {
  const group = (detail?.attributeGroups || []).find((g) => g.key === "nutrient");
  if (!group) return null;
  const get = (key) => {
    const a = (group.attributes || []).find((x) => x.attribute?.key === key);
    return a ? (a.value?.title ?? a.value?.key ?? null) : null;
  };
  // Energy comes as "389,2/1625,6" (kcal/kJ) — the first number is kcal. A bare
  // kJ-only value would exceed any plausible kcal/100g (~900 max for pure fat).
  let kcal = num(get("calorie"));
  if (kcal != null && kcal > 950) kcal = Math.round((kcal / 4.184) * 10) / 10;
  const protein = num(get("proteins"));
  const fat = num(get("fats"));
  const carbs = num(get("carbohydrates"));
  if (kcal == null && protein == null && fat == null && carbs == null) return null;
  return { kcal, protein, fat, carbs };
}

async function fetchAllCategories() {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await fetchJson(`${BASE}/categories?limit=500&offset=${offset}`, { headers: HEADERS });
    const items = data?.items || [];
    all.push(...items);
    offset += items.length;
    if (!items.length || offset >= (data?.total ?? 0)) break;
  }
  return all;
}

async function run() {
  console.log(`[silpo] Branch ${BRANCH_ID}`);
  console.log("[silpo] Fetching categories…");
  const cats = await fetchAllCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  console.log(`[silpo] Categories: ${cats.length}`);

  // Resolve a leaf slug to its root top + full title path.
  function resolve(slug) {
    let c = bySlug.get(slug);
    if (!c) return null;
    const titles = [c.title];
    const seen = new Set([c.id]);
    while (c.parentId) {
      const p = byId.get(c.parentId);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      titles.unshift(p.title);
      c = p;
    }
    return { topKey: slugKey(c.slug), topTitle: c.title, path: titles.join(" / ") };
  }

  const tops = cats.filter((c) => !c.parentId);
  const sections = tops.filter((t) => FOOD_TOP_KEYS.has(slugKey(t.slug)));
  // Baby goods top is mostly non-food (toys, diapers); scrape only its food branch.
  const babyTop = tops.find((t) => slugKey(t.slug) === "dytiachi-tovary");
  if (babyTop) {
    const babyFood = cats.filter((c) => c.parentId === babyTop.id && /харчуванн/i.test(c.title));
    if (babyFood.length) sections.push(...babyFood);
    else sections.push(babyTop);
  }
  console.log(`[silpo] Sections to scrape: ${sections.map((s) => s.slug).join(", ")}`);

  // ---- Pass 1: paginate product lists (prices, discounts, sizes — no nutrition).
  const byProductId = new Map();
  let listed = 0;
  await pool(sections, LIST_CONCURRENCY, async (section) => {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const url = `${BASE}/products?limit=${PAGE}&offset=${offset}&category=${encodeURIComponent(section.slug)}&includeChildCategories=true`;
      const data = await fetchJson(url, { headers: HEADERS });
      const items = data?.items || [];
      total = data?.total ?? 0;
      for (const p of items) {
        listed++;
        if (p.externalProductId == null || byProductId.has(p.externalProductId)) continue;
        byProductId.set(p.externalProductId, p);
      }
      if (!items.length) break;
      offset += items.length;
    }
    console.log(`[silpo]  listed ${section.slug}: unique so far ${byProductId.size}`);
  });
  console.log(`[silpo] List pass done: ${byProductId.size} unique products (${listed} listings)`);

  // ---- Pass 2: fetch details for nutrition, with a persistent cache.
  // Cache values: object = nutrition, false = fetched but has none. Errors are
  // not cached so a re-run retries them.
  const cache = (await readJsonIfExists(CACHE_PATH)) || {};
  const todo = [...byProductId.values()].filter((p) => !(p.externalProductId in cache));
  console.log(`[silpo] Details: ${todo.length} to fetch, ${byProductId.size - todo.length} cached`);

  let done = 0;
  let errors = 0;
  await pool(todo, DETAIL_CONCURRENCY, async (p) => {
    try {
      const detail = await fetchJson(`${BASE}/products/${encodeURIComponent(p.slug)}`, { headers: HEADERS, tries: 4 });
      cache[p.externalProductId] = detail ? (extractNutrition(detail) ?? false) : false;
    } catch (e) {
      errors++;
      if (errors <= 20) console.warn(`[silpo]  ! detail ${p.slug}: ${e.message}`);
    }
    done++;
    if (done % 500 === 0) {
      await writeJson(CACHE_PATH, cache);
      console.log(`[silpo]  details ${done}/${todo.length} (errors: ${errors})`);
    }
    await sleep(30); // stay polite
  });
  await writeJson(CACHE_PATH, cache);
  console.log(`[silpo] Details done (errors: ${errors})`);

  // ---- Assemble snapshot: keep only products with at least one nutrient value.
  const products = [];
  for (const p of byProductId.values()) {
    const nutrition = cache[p.externalProductId];
    if (!nutrition || typeof nutrition !== "object") continue;
    const info = resolve(p.sectionSlug) || { topKey: "other", topTitle: "Інше", path: "Інше" };
    const size = parseSize(p.displayRatio, p.weighted === true);
    // `price`/`oldPrice` are per ratio unit (per kg for weighted goods, per
    // piece otherwise). `displayPrice` is per displayRatio (per 100 g for
    // weighted goods) — NOT what the per-kg "kg" unit semantics expect.
    const price = typeof p.price === "number" ? p.price : null;
    const oldPriceRaw = typeof p.oldPrice === "number" ? p.oldPrice : null;
    products.push({
      id: `slp${p.externalProductId}`,
      title: p.title,
      top: { id: info.topKey, title: info.topTitle },
      path: info.path,
      price,
      oldPrice: oldPriceRaw != null && price != null && oldPriceRaw > price ? oldPriceRaw : null,
      weight: size.weight,
      volume: size.volume,
      unit: size.unit,
      kcal: nutrition.kcal ?? null,
      protein: nutrition.protein ?? null,
      fat: nutrition.fat ?? null,
      carbs: nutrition.carbs ?? null,
      brand: p.brandTitle || null,
      img: p.icon ? `https://images.silpo.ua/products/300x300/${p.icon}` : null,
      url: p.slug ? `https://silpo.ua/product/${p.slug}` : null,
      inStock: (p.stock ?? 0) > 0,
    });
  }

  const snapshot = {
    store: "silpo",
    title: "Сільпо Львів",
    storeRef: BRANCH_ID,
    generatedAt: new Date().toISOString(),
    totalSeen: byProductId.size,
    products,
  };
  await writeJson(join(RAW_DIR, "silpo.json"), snapshot);
  console.log(
    `[silpo] DONE: kept ${products.length} of ${byProductId.size} seen, discounts: ${products.filter((x) => x.oldPrice != null).length}`
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
