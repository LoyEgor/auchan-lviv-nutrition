// Scraper for Auchan Lviv DRIVE catalog via the public zakaz.ua JSON API.
// Walks the 32 top-level categories (whose products endpoint returns the whole
// subtree), paginates them, normalizes nutrition facts into numeric fields and
// writes a trimmed snapshot to public/data/. Each product's leaf category path
// is resolved from its own category_id via a map built from the category tree.
//
// No external deps: relies on Node 18+ global fetch. Run: `node scraper/scrape.mjs`.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STORE_ID = "48246409"; // Auchan Lviv DRIVE
const BASE = `https://stores-api.zakaz.ua/stores/${STORE_ID}`;
const HEADERS = {
  "Accept-Language": "uk",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};
const PER_PAGE = 100; // API rejects per_page > 100 with HTTP 400
const CONCURRENCY = 6;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 200) return await res.json();
      if (res.status === 404) return null;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(600 * (i + 1)); // linear backoff, polite
  }
  throw new Error(`failed ${url}: ${lastErr?.message}`);
}

// Pull the first numeric value out of strings like "197.00kcal", "9.95g".
function num(s) {
  if (s == null) return null;
  const m = String(s).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Energy may rarely come as kJ — normalize to kcal.
function energyKcal(s) {
  const n = num(s);
  if (n == null) return null;
  if (/kj/i.test(String(s)) && !/kcal/i.test(String(s))) return Math.round((n / 4.184) * 10) / 10;
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
  console.log("Fetching category tree…");
  const tree = await fetchJson(`${BASE}/categories/`);
  if (!tree) throw new Error("no category tree");

  const topCategories = tree.map((t) => ({ id: t.id, title: t.title, count: t.count }));
  const catMap = new Map();
  buildCatMap(tree, [], null, null, catMap);
  console.log(`Top categories: ${topCategories.length}, total category nodes: ${catMap.size}`);

  const byEan = new Map();
  let totalSeen = 0;
  let processed = 0;

  // Fetch one top-level category fully (all pages of its whole subtree).
  async function processTop(top) {
    let page = 1;
    while (true) {
      const url = `${BASE}/categories/${encodeURIComponent(top.id)}/products/?page=${page}&per_page=${PER_PAGE}`;
      const data = await fetchJson(url);
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
        const info = catMap.get(p.category_id) || catMap.get(p.parent_category_id) || { path: [top.title], topId: top.id, topTitle: top.title };
        byEan.set(p.ean, {
          id: p.ean,
          title: p.title,
          cat: info.topId || top.id,
          catTitle: info.topTitle || top.title,
          path: info.path.join(" / "),
          price: typeof p.price === "number" ? p.price / 100 : null,
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
    console.log(`  [${processed}/${topCategories.length}] ${top.title} — kept ${byEan.size}, seen ${totalSeen}`);
  }

  // Simple concurrency pool over top categories.
  console.log("Fetching products…");
  const queue = [...topCategories];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const top = queue.shift();
      try {
        await processTop(top);
      } catch (e) {
        console.warn(`  ! top ${top.id} failed: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);

  const products = [...byEan.values()];

  const keptByCat = new Map();
  for (const p of products) keptByCat.set(p.cat, (keptByCat.get(p.cat) || 0) + 1);
  const categories = topCategories
    .map((c) => ({ id: c.id, title: c.title, count: keptByCat.get(c.id) || 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  const meta = {
    store: "Auchan Lviv DRIVE",
    storeId: STORE_ID,
    generatedAt: new Date().toISOString(),
    totalSeen,
    totalKept: products.length,
    withKcal: products.filter((p) => p.kcal != null).length,
    withProtein: products.filter((p) => p.protein != null).length,
    withFat: products.filter((p) => p.fat != null).length,
    withCarbs: products.filter((p) => p.carbs != null).length,
    full4: products.filter((p) => p.kcal != null && p.protein != null && p.fat != null && p.carbs != null).length,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "products.json"), JSON.stringify(products));
  await writeFile(join(OUT_DIR, "categories.json"), JSON.stringify(categories, null, 2));
  await writeFile(join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log("\n=== DONE ===");
  console.log(meta);
  console.log(`categories kept: ${categories.length}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
