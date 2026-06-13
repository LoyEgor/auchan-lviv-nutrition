// Merges the raw per-store snapshots (scraper/raw/*.json) into the static
// dataset served by the SPA: products with a `store` tag and unified category
// ids, a unified category list with per-store counts and a representative
// thumbnail, and combined meta. Run after the scrapers: `node scraper/build-data.mjs`.

import { join } from "node:path";
import { RAW_DIR, OUT_DIR, readJsonIfExists, writeJson } from "./lib.mjs";

// One category list across stores. Order here is the fallback display order;
// the UI sorts by product count.
const UNIFIED = [
  { id: "fruits-vegetables", title: "Фрукти та овочі" },
  { id: "meat", title: "М'ясо та ковбаси" },
  { id: "fish", title: "Риба та морепродукти" },
  { id: "dairy-eggs", title: "Молочне, сири та яйця" },
  { id: "bakery", title: "Хліб та випічка" },
  { id: "grocery", title: "Бакалія та консерви" },
  { id: "sweets", title: "Солодощі" },
  { id: "snacks", title: "Чипси та снеки" },
  { id: "sauces", title: "Соуси та спеції" },
  { id: "drinks", title: "Напої" },
  { id: "coffee-tea", title: "Кава та чай" },
  { id: "frozen", title: "Заморозка" },
  { id: "ready-meals", title: "Кулінарія" },
  { id: "healthy", title: "Здорове харчування" },
  { id: "baby", title: "Дитяче харчування" },
  { id: "alcohol", title: "Алкоголь" },
  { id: "pets", title: "Товари для тварин" },
  { id: "other", title: "Інше" },
];

// Native top-category id (Auchan/zakaz id, or Silpo slug key) → unified id.
const TOP_TO_UNIFIED = {
  // Auchan (zakaz.ua)
  "fruits-and-vegetables-auchan": "fruits-vegetables",
  "meat-fish-poultry-auchan": "meat",
  "fish-and-seafood-auchan": "fish",
  "dairy-and-eggs-auchan": "dairy-eggs",
  "bakery-auchan": "bakery",
  "grocery-and-sweets-auchan": "grocery",
  "canned-food-auchan": "grocery",
  "world-cuisine-auchan": "grocery",
  "sweets-and-snacks-auchan": "sweets",
  "crisps-and-snacks-auchan": "snacks",
  "sauces-and-spices-auchan": "sauces",
  "drinks-auchan": "drinks",
  "hot-drinks-auchan": "coffee-tea",
  "frozen-auchan": "frozen",
  "ready-meals-auchan": "ready-meals",
  "bioproducts-and-diabetic-goods-auchan": "healthy",
  "babies-auchan": "baby",
  "eighteen-plus-auchan": "alcohol",
  "for-animals-auchan": "pets",
  // Silpo (slug keys, numeric tail stripped)
  "frukty-ovochi": "fruits-vegetables",
  "m-iaso": "meat",
  "kovbasni-vyroby-i-m-iasni-delikatesy": "meat",
  ryba: "fish",
  "molochni-produkty-ta-iaitsia": "dairy-eggs",
  syry: "dairy-eggs",
  "khlib-ta-vypichka": "bakery",
  "bakaliia-i-konservy": "grocery",
  solodoshchi: "sweets",
  "sneky-ta-chypsy": "snacks",
  "sousy-i-spetsii": "sauces",
  napoi: "drinks",
  "kava-chai": "coffee-tea",
  "zamorozhena-produktsiia": "frozen",
  "gotovi-stravy-i-kulinariia": "ready-meals",
  "zdorove-kharchuvannia": "healthy",
  bady: "healthy",
  "dytiachi-tovary": "baby",
  alkogol: "alcohol",
  "dlia-tvaryn": "pets",
};

const r1 = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);

const EXPECTED_STORES = ["auchan", "silpo"];

async function run() {
  const snapshots = [];
  const missing = [];
  for (const name of EXPECTED_STORES) {
    const snap = await readJsonIfExists(join(RAW_DIR, `${name}.json`));
    if (snap?.products?.length) snapshots.push(snap);
    else missing.push(name);
  }
  // Fail hard rather than silently publish a half-store dataset. The deploy
  // workflow's `npm run scrape || (fallback)` then keeps the last committed
  // (complete) snapshot. Set BUILD_ALLOW_PARTIAL=1 to override for local dev.
  if (missing.length && !process.env.BUILD_ALLOW_PARTIAL) {
    throw new Error(
      `missing raw snapshot(s): ${missing.join(", ")}. Run the scrapers, or set BUILD_ALLOW_PARTIAL=1 to build with what's present.`
    );
  }
  if (missing.length) console.warn(`[build] BUILD_ALLOW_PARTIAL set — building without: ${missing.join(", ")}`);
  if (!snapshots.length) throw new Error("no raw snapshots found; run the scrapers first");

  const unmappedTops = new Map();
  const products = [];
  for (const snap of snapshots) {
    for (const p of snap.products) {
      let cat = TOP_TO_UNIFIED[p.top.id];
      if (!cat) {
        unmappedTops.set(p.top.id, (unmappedTops.get(p.top.id) || 0) + 1);
        cat = "other";
      }
      // Normalize money once, for both stores: a non-positive price is "not
      // priced" (a few SKUs list 0) — treat as unknown so it doesn't pollute
      // cheapest-protein sorts; an old price only counts when it's above price.
      const price = typeof p.price === "number" && p.price > 0 ? p.price : null;
      const oldPrice = price != null && typeof p.oldPrice === "number" && p.oldPrice > price ? p.oldPrice : null;
      products.push({
        id: p.id,
        store: snap.store,
        title: p.title,
        cat,
        path: p.path,
        price,
        oldPrice,
        weight: p.weight,
        volume: p.volume,
        unit: p.unit,
        // One decimal is below measurement noise for per-100g values and trims
        // the snapshot a little (parse time / bytes before gzip).
        kcal: r1(p.kcal),
        protein: r1(p.protein),
        fat: r1(p.fat),
        carbs: r1(p.carbs),
        brand: p.brand,
        img: p.img,
        url: p.url,
        inStock: p.inStock,
      });
    }
  }
  for (const [top, n] of unmappedTops) console.warn(`[build] unmapped top "${top}" (${n} products) → other`);

  // Per-category counts and a representative thumbnail (shortest in-stock
  // product title tends to be a generic staple — a recognizable image).
  const byCat = new Map();
  for (const p of products) {
    let agg = byCat.get(p.cat);
    if (!agg) byCat.set(p.cat, (agg = { count: 0, counts: {}, best: null }));
    agg.count++;
    agg.counts[p.store] = (agg.counts[p.store] || 0) + 1;
    if (p.img && p.inStock) {
      if (!agg.best || p.title.length < agg.best.title.length) agg.best = p;
    }
  }
  const categories = UNIFIED.filter((c) => byCat.has(c.id)).map((c) => {
    const agg = byCat.get(c.id);
    return { id: c.id, title: c.title, count: agg.count, counts: agg.counts, img: agg.best?.img ?? null };
  });
  categories.sort((a, b) => b.count - a.count);

  const stat = (list) => ({
    totalKept: list.length,
    withKcal: list.filter((p) => p.kcal != null).length,
    withProtein: list.filter((p) => p.protein != null).length,
    withFat: list.filter((p) => p.fat != null).length,
    withCarbs: list.filter((p) => p.carbs != null).length,
    full4: list.filter((p) => p.kcal != null && p.protein != null && p.fat != null && p.carbs != null).length,
    withDiscount: list.filter((p) => p.oldPrice != null).length,
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    totalSeen: snapshots.reduce((s, x) => s + (x.totalSeen || 0), 0),
    ...stat(products),
    stores: snapshots.map((snap) => ({
      store: snap.store,
      title: snap.title,
      storeRef: snap.storeRef,
      generatedAt: snap.generatedAt,
      totalSeen: snap.totalSeen,
      ...stat(products.filter((p) => p.store === snap.store)),
    })),
  };

  await writeJson(join(OUT_DIR, "products.json"), products);
  await writeJson(join(OUT_DIR, "categories.json"), categories, true);
  await writeJson(join(OUT_DIR, "meta.json"), meta, true);

  console.log("[build] DONE");
  console.log(meta);
  console.log(`[build] categories: ${categories.map((c) => `${c.title}=${c.count}`).join(", ")}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
