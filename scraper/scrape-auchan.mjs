// Scraper for the Auchan Lviv DRIVE catalog via the public zakaz.ua JSON API.
// Walks the top-level categories (whose products endpoint returns the whole
// subtree), paginates them, normalizes nutrition facts into numeric fields and
// writes a raw per-store snapshot to scraper/raw/auchan.json. Each product's
// leaf category path is resolved from its own category_id via a map built from
// the category tree.
//
// No external deps: relies on Node 18+ global fetch. Run: `node scraper/scrape-auchan.mjs`.

import { join } from "node:path";
import { RAW_DIR, fetchJson, num, pool, writeJson } from "./lib.mjs";

const STORE_ID = "48246409"; // Auchan Lviv DRIVE
const BASE = `https://stores-api.zakaz.ua/stores/${STORE_ID}`;
const HEADERS = {
  "Accept-Language": "uk",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};
const PER_PAGE = 100; // API rejects per_page > 100 with HTTP 400
const CONCURRENCY = 6;

// Energy may rarely come as kJ — normalize to kcal.
function energyKcal(s) {
  const n = num(s);
  if (n == null) return null;
  if (/kj|кдж/i.test(String(s)) && !/kcal|ккал/i.test(String(s))) return Math.round((n / 4.184) * 10) / 10;
  return n;
}

// Build id -> {path, topId, topTitle} for every node in the tree.
function buildCatMap(nodes, trail, topId, topTitle, map) {
  for (const n of nodes) {
    const isTop = trail.length === 0;
    const tId = isTop ? n.id : topId;
    const tTitle = isTop ? n.title : topTitle;
    const path = [...trail, n.title];
    map.set(n.id, { path, topId: tId, topTitle: tTitle });
    if (Array.isArray(n.children) && n.children.length) {
      buildCatMap(n.children, path, tId, tTitle, map);
    }
  }
}

function pickImage(img) {
  if (!img || typeof img !== "object") return null;
  return (
    img.s200x200 ||
    img.s350x350 ||
    img.s464x464 ||
    img.main ||
    img.normal ||
    Object.values(img).find((v) => typeof v === "string" && v.startsWith("http")) ||
    null
  );
}

async function run() {
  console.log("[auchan] Fetching category tree…");
  const tree = await fetchJson(`${BASE}/categories/`, { headers: HEADERS });
  if (!tree) throw new Error("no category tree");

  const topCategories = tree.map((t) => ({ id: t.id, title: t.title }));
  const catMap = new Map();
  buildCatMap(tree, [], null, null, catMap);
  console.log(`[auchan] Top categories: ${topCategories.length}, total nodes: ${catMap.size}`);

  const byEan = new Map();
  let totalSeen = 0;
  let processed = 0;

  // Fetch one top-level category fully (all pages of its whole subtree).
  async function processTop(top) {
    let page = 1;
    while (true) {
      const url = `${BASE}/categories/${encodeURIComponent(top.id)}/products/?page=${page}&per_page=${PER_PAGE}`;
      const data = await fetchJson(url, { headers: HEADERS });
      const results = data?.results || [];
      if (!results.length) break;
      for (const p of results) {
        totalSeen++;
        const nf = p.nutrition_facts || {};
        const kcal = energyKcal(nf.ingredient_energy);
        const protein = num(nf.ingredient_protein);
        const fat = num(nf.ingredient_fat);
        const carbs = num(nf.ingredient_carbohydrates);
        // Keep only food with at least one nutrient value.
        if (kcal == null && protein == null && fat == null && carbs == null) continue;
        if (byEan.has(p.ean)) continue;
        const info = catMap.get(p.category_id) ||
          catMap.get(p.parent_category_id) || { path: [top.title], topId: top.id, topTitle: top.title };
        const discounted =
          p.discount?.status === true &&
          typeof p.discount.old_price === "number" &&
          typeof p.price === "number" &&
          p.discount.old_price > p.price;
        byEan.set(p.ean, {
          id: p.ean,
          title: p.title,
          top: { id: info.topId || top.id, title: info.topTitle || top.title },
          path: info.path.join(" / "),
          price: typeof p.price === "number" ? p.price / 100 : null,
          oldPrice: discounted ? p.discount.old_price / 100 : null,
          weight: p.weight ?? null,
          volume: p.volume ?? null,
          unit: p.unit ?? null,
          kcal,
          protein,
          fat,
          carbs,
          brand: p.producer?.trademark || null,
          img: pickImage(p.img),
          url: p.web_url || null,
          inStock: p.in_stock !== false,
        });
      }
      if (results.length < PER_PAGE) break;
      page++;
    }
    processed++;
    console.log(`[auchan]  [${processed}/${topCategories.length}] ${top.title} — kept ${byEan.size}, seen ${totalSeen}`);
  }

  console.log("[auchan] Fetching products…");
  await pool(topCategories, CONCURRENCY, async (top) => {
    try {
      await processTop(top);
    } catch (e) {
      console.warn(`[auchan]  ! top ${top.id} failed: ${e.message}`);
    }
  });

  const products = [...byEan.values()];
  const snapshot = {
    store: "auchan",
    title: "Ашан Львів",
    storeRef: STORE_ID,
    generatedAt: new Date().toISOString(),
    totalSeen,
    products,
  };
  await writeJson(join(RAW_DIR, "auchan.json"), snapshot);
  console.log(`[auchan] DONE: kept ${products.length} of ${totalSeen} seen, discounts: ${products.filter((p) => p.oldPrice != null).length}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
