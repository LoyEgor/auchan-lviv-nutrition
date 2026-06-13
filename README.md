# Каталог за КБЖВ · Ашан і Сільпо (Львів)

A rebuilt grocery catalog of **Auchan Lviv DRIVE** (zakaz.ua) and a **Silpo Lviv**
branch that lets you **search, filter and sort the combined assortment by
nutrition** — calories, protein, fat, carbs — which the original sites do not
allow.

Answers questions like:

- ice cream with the most protein,
- products with the most protein per calorie (lean protein),
- discounted products only, in either store,
- …all of it, scoped to a category (e.g. only meat & fish) or across everything.

## How it works

Two scrapers pull the catalogs from the stores' public JSON APIs and write raw
per-store snapshots; a build step merges them into one static dataset with
unified categories. The front-end is a Vite + React SPA that loads that
snapshot and does all search / filter / sort **in the browser** — no backend.

```
scraper/scrape-auchan.mjs  → scraper/raw/auchan.json   (stores-api.zakaz.ua, store 48246409)
scraper/scrape-silpo.mjs   → scraper/raw/silpo.json    (sf-ecom-api.silpo.ua, Lviv branch)
scraper/build-data.mjs     → public/data/{products,categories,meta}.json
src/                       → Vite + React UI (loads the snapshot, in-memory filtering)
```

Store specifics:

- **Auchan (zakaz.ua)**: nutrition comes structured in the product list;
  prices in kopecks; discounts in `discount.{status,old_price}`.
- **Silpo (sf-ecom-api)**: product lists carry prices/discounts/pack sizes but
  no nutrition — the scraper fetches each product's detail page (attribute
  group `nutrient`) with an on-disk cache (`scraper/raw/silpo.details-cache.json`),
  so re-runs only fetch new items. Weighted goods (`weighted: true`) are priced
  per kg. The branch is configurable via `SILPO_BRANCH_ID`.

### Snapshot stats (current)

~34.5k products with nutrition data (~21.9k Auchan + ~12.6k Silpo) across 18
unified categories; ~6.5k products with an active discount.

## Develop

```bash
npm install
npm run scrape   # both stores + merge (~5 min first time, faster after — silpo details are cached)
npm run dev      # http://localhost:5173
npm test         # unit tests for the fuzzy search engine
```

Individual steps: `npm run scrape:auchan`, `npm run scrape:silpo`,
`npm run build:data` (merge only — fast, no network).

## Build / deploy

```bash
npm run build    # type-checks and bundles to dist/ (public/data is copied in)
npm run preview
```

`base: "./"` in `vite.config.ts` keeps asset paths relative, so the build works
locally, on any static host, and on a GitHub Pages project subpath.

A ready-to-use **GitHub Actions** workflow (`.github/workflows/deploy.yml`)
re-scrapes **both stores daily** at 09:17 UTC (≈ midday Kyiv — late enough that
both retailers have rolled over to today's prices/stock, since they update on
their own non-instant schedules), plus on push and manual dispatch, and deploys
the fresh snapshot to GitHub Pages — no manual scraping needed. To enable: push
to GitHub, then Settings → Pages → Source = "GitHub Actions".

The workflow caches `scraper/raw/` (which holds the Silpo per-product nutrition
cache) between runs via `actions/cache`, so each run only fetches newly-listed
products instead of re-fetching ~15k Silpo detail pages from cold. The scrape is
all-or-nothing — `public/data` is republished only when both stores scrape
cleanly, otherwise the last committed (complete) snapshot is deployed — and the
job has a 30-minute timeout so a hung run can't stall the pipeline.

## Features

- **Fuzzy UK/RU search** (`src/search/`) tuned for Russian speakers querying a
  Ukrainian catalog:
  - character folding (і/и, є/е, ї, ы, э, ё, ґ, apostrophes) so spelling
    variants compare equal;
  - weighted prefix edit distance where confusable letters {е, и, о, й} cost
    half an edit (хлеб→хліб, сок→сік, сёмга→сьомга) and full-cost edits are
    banned in the first two letters (keeps мука away from макарони);
  - a RU→UK food lexicon for words that differ entirely (творог→сир
    кисломолочний, клубника→полуниця, мука→борошно, кофе→кава…), reachable
    through typos and partial input, with closest-key disambiguation.
  - **"Did you mean" suggestions** (`src/search/suggest.ts`): when a query
    returns nothing, the closest catalog terms and dictionary hits are offered
    as clickable chips (shown in their real spelling, not the folded form). A
    zero-result page also distinguishes a misspelled term from over-tight
    filters and offers the matching fix.
- **Two stores** with a store filter and per-product store badges; same product
  may appear in both stores at different prices.
- **Discounts**: old price shown struck through, "Лише зі знижкою" filter.
- **Cross-store price comparison** (`src/crossStore.ts`): the same item is matched
  across stores (conservatively — same brand + pack size + fat % + pack count,
  with strong title-token overlap and a sanity cap on price spread), and each row
  shows where it is cheaper ("↘ Сільпо −18%") or that it is the cheapest. A "Дешевше
  в іншому магазині" filter narrows to items with a cheaper equivalent elsewhere.
- **Healthier alternatives** (`src/healthier.ts`): a "🥗 заміна" button on each
  row opens same-category, same-food-family items with meaningfully more protein
  per 100 kcal (the project's north-star metric, guarded against near-zero-calorie
  artifacts and generic-adjective mismatches), flagged when also cheaper per gram
  of protein. Turns the catalog from a sortable table into an advisor.
- **Category blocks in search results**: while searching, the results header
  shows per-category hit counts with thumbnails; tap to scope, tap again to
  unscope.
- **Persistence**: all filters/sort and the search history (last 10 queries,
  dropdown under the search box) survive page reloads via localStorage.
- Filter by unified category, min/max range filters per nutrient (per 100 g),
  **protein-density filter** (protein per 100 kcal ≥ N).
- Sort by calories, protein, fat, carbs, price, **₴/100 g**, **₴/100 g protein**,
  and **protein per 100 kcal**. Items missing the sorted value go last.
- Toggle display basis: **per 100 g** ↔ **per package** (scaled by weight/volume).
- **Scenario presets** (one click sets filters + sort, tuned empirically):
  «Дешевий білок», «Сито, мало калорій», «Білок без жиру», «Об'ємна їжа».
- **Data-quality toggles**: hide pet food; "only plausible data" (Atwater check
  4·P + 9·F + 4·C vs stated kcal, >50% mismatch hidden).
- Mobile: filter drawer with instant category apply + auto-close, removable
  active-filter badges, «Очистити» next to «Показати».
- **Light / dark theme**: follows the OS preference by default, with a header
  toggle whose choice is persisted. The theme is applied by an inline script in
  `index.html` before first paint (no flash); all colours are CSS tokens in
  `:root` overridden under `[data-theme="dark"]`.

## Performance

- The data snapshot is `products.json` ≈ **18 MB raw / ≈ 3.1 MB gzipped**. Static
  hosts (GitHub Pages included) gzip text assets automatically, so the over-the-
  wire cost is the gzipped size. The raw field breakdown is img 23% / url 21% /
  title 20% / path 13%; those repeat heavily, so gzip already collapses them —
  stripping the shared URL prefixes would cut raw bytes (parse time) but barely
  move the gzipped transfer, which is why it isn't done.
- **Indexes are built off the first-paint path.** The search vocabulary (~16k
  tokens) and the cross-store equivalence map (over 34k products) are
  constructed in a deferred task *after* the catalog first renders, so the table
  is visible/scrollable immediately; search and cross-store hints light up a
  beat later. All readers guard the "not yet built" state.
- All filtering/sorting is in-memory over the full list and runs per keystroke;
  the virtualized table/cards keep the DOM small regardless of result count.

## Known limitations

- **Data quality is the retailers'.** Some SKUs have wrong/swapped nutrition at
  the source. The scrapers do not "correct" source data.
- **No salt/sugar split** — both APIs expose only energy / protein / fat / carbs
  as structured data.
- Values are **per 100 g**; per-package is computed from the known pack size and
  shown as `—` when unknown (e.g. weight-priced goods).
- The snapshot is a point-in-time copy; prices, discounts and stock change
  between scrapes.
- `products.json` is loaded whole (the global search, sort and cross-store
  features need it). If it grows much larger, the next lever is sharding by
  category with on-demand loading — see Performance above for why prefix-
  stripping/pre-compression aren't worth it on a gzipping host.
