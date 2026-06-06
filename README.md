# Ашан Львів · каталог за КБЖУ

A rebuilt catalog of the **Auchan Lviv DRIVE** store (zakaz.ua) that lets you
**search, filter and sort the whole assortment by nutrition** — calories,
protein, fat, carbs — which the original site does not allow.

Answers questions like:

- ice cream with the most protein,
- products with the most protein per calorie (lean protein),
- high-calorie items with (almost) no fat,
- …all of it, scoped to a category (e.g. only meat & fish) or across everything.

## How it works

A small scraper pulls the catalog from the public zakaz.ua JSON API
(`stores-api.zakaz.ua`, store id `48246409`), normalizes the `nutrition_facts`
strings (`"197.00ккал"` → `197`) into numeric fields, keeps only items that have
**at least one** nutrient value, and writes a static snapshot to
`public/data/`. The front-end is a Vite + React SPA that loads that snapshot and
does all search / filter / sort **in the browser** — no backend.

```
scraper/scrape.mjs   → public/data/{products,categories,meta}.json
src/                 → Vite + React UI (loads the snapshot, in-memory filtering)
```

### Snapshot stats (current)

~21.7k products with nutrition data out of ~49k scanned, across 23 categories.

## Develop

```bash
npm install
npm run scrape   # fetch a fresh snapshot into public/data/ (~1–2 min, polite)
npm run dev      # http://localhost:5173
```

## Build / deploy

```bash
npm run build    # type-checks and bundles to dist/ (public/data is copied in)
npm run preview
```

`base: "./"` in `vite.config.ts` keeps asset paths relative, so the build works
locally, on any static host, and on a GitHub Pages project subpath.

A ready-to-use **GitHub Actions** workflow (`.github/workflows/deploy.yml`)
re-scrapes weekly and deploys to GitHub Pages. To enable: push to GitHub,
then set Settings → Pages → Source = "GitHub Actions".

## Features

- Search by name / brand (all words must match).
- Filter by top-level category.
- Min/max range filters per nutrient (per 100 g) — e.g. `fat: до 1` for fat-free.
- **Protein-density filter** (protein per 100 kcal ≥ N) — the key guard that
  separates real protein foods from cheap bulk carbs whose protein is incidental
  (flour, pasta) and from near-zero-calorie non-foods (tea, spices).
- Sort by calories, protein, fat, carbs, price, **₴/100 g**, **₴/100 g protein**
  (cheapest protein per money), and **protein per 100 kcal**. Items missing the
  sorted value go last.
- Toggle display basis: **per 100 g** ↔ **per package** (scaled by weight/volume).
- **Scenario presets** (one click sets filters + sort, tuned empirically against
  the snapshot):
  - **Дешевий білок** — most protein per money (legumes, cheap meat, canned fish).
  - **Сито, мало калорій** — most protein per calorie (seafood, fish, egg white).
  - **Білок без жиру** — lean protein, ranked by cost per protein.
  - **Об'ємна їжа** — low energy density, fills by volume.
- **Data-quality toggles**: hide pet food (on by default — this is a human-food
  tool); "only plausible data" runs an Atwater check (4·P + 9·F + 4·C vs stated
  kcal, >50% mismatch hidden) to drop egregiously wrong SKUs (e.g. oil listed
  with carbs 92, items with impossible energy).

### Why presets, not just more filters

The raw range+sort primitives are expressive, but the data has traps a newcomer
won't anticipate: sorting by raw protein rewards dehydrated/processed goods
(gelatin, jerky); sorting by protein-per-calorie rewards near-zero-calorie
non-foods (tea, coffee, mustard); cheapest-protein-per-money rewards flour. Each
preset bakes in the floors that avoid these, so you get a useful list without
knowing the traps.

## Known limitations

- **Data quality is the retailer's.** Some SKUs have wrong/swapped nutrition at
  the source (e.g. a specific olive-oil variant listing fat 0 / carbs 92). The
  scraper does not "correct" source data.
- **No salt field** — zakaz.ua exposes only energy / protein / fat / carbs as
  structured data; salt appears only in free-text ingredients sometimes.
- Values are **per 100 g**; per-package is computed from `weight` and is shown as
  `—` when the weight is unknown.
- The snapshot is a point-in-time copy; prices and stock change between scrapes.
- `products.json` is ~11 MB uncompressed (~2–3 MB gzipped, which static hosts
  serve automatically). If load time matters later, shard by category or
  pre-compress.
