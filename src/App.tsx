import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Product, Category, Meta, NutrientKey, Basis, StoreId } from "./types";
import {
  nutrientValue,
  pricePer100g,
  proteinPerKcal,
  pricePerProtein,
  isPlausible,
  fmt,
  fmtPrice,
  fmtWeight,
  compareNullable,
} from "./lib";
import { buildSearchIndex, createMatcher, suggestTerms } from "./search";
import type { SearchIndex } from "./search";
import { buildCrossStore } from "./crossStore";
import type { CrossStoreInfo } from "./crossStore";
import { findHealthier } from "./healthier";
import { FILTERS_KEY, loadJSON, saveJSON, loadHistory, pushHistory, clearHistory, saveTheme } from "./persist";
import type { HistoryEntry, Theme } from "./persist";

type SortKey = "title" | NutrientKey | "price" | "pricePer100" | "pricePerProtein" | "proteinPerKcal";
type Range = { min: string; max: string };
const emptyRange = (): Range => ({ min: "", max: "" });
type Ranges = Record<NutrientKey, Range>;
const emptyRanges = (): Ranges => ({ kcal: emptyRange(), protein: emptyRange(), fat: emptyRange(), carbs: emptyRange() });

const PET_FOOD_CAT = "pets";

type StoreFilter = "all" | StoreId;
const STORE_OPTIONS: { key: StoreFilter; label: string }[] = [
  { key: "auchan", label: "Ашан" },
  { key: "silpo", label: "Сільпо" },
  { key: "all", label: "Обидва" },
];
const STORE_BADGE: Record<StoreId, { label: string; cls: string }> = {
  auchan: { label: "Ашан", cls: "store-badge auchan" },
  silpo: { label: "Сільпо", cls: "store-badge silpo" },
};
// Ascending is "better" for these (cheaper / text); numbers default to descending.
const ASC_DEFAULT = new Set<SortKey>(["title", "pricePer100", "pricePerProtein"]);

const ROW_H = 52;
const CARD_H = 148;

interface Column {
  key: SortKey;
  label: string;
  title?: string;
  align?: "left" | "right";
  accent?: boolean;
}

const COLUMNS: Column[] = [
  { key: "title", label: "Назва", align: "left" },
  { key: "kcal", label: "Ккал", align: "right" },
  { key: "protein", label: "Білки", align: "right" },
  { key: "fat", label: "Жири", align: "right" },
  { key: "carbs", label: "Вугл.", align: "right" },
  { key: "proteinPerKcal", label: "Б/100ккал", title: "Білок на 100 ккал — щільність білка", align: "right", accent: true },
  { key: "pricePerProtein", label: "₴/100гБ", title: "Ціна за 100 г білка — раціональність за гроші", align: "right", accent: true },
  { key: "pricePer100", label: "₴/100г", title: "Ціна за 100 г / 100 мл", align: "right" },
  { key: "price", label: "Ціна", align: "right" },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "pricePerProtein", label: "₴ за 100 г білка" },
  { key: "proteinPerKcal", label: "Білок на 100 ккал" },
  { key: "kcal", label: "Калорії" },
  { key: "protein", label: "Білки" },
  { key: "fat", label: "Жири" },
  { key: "carbs", label: "Вуглеводи" },
  { key: "pricePer100", label: "Ціна за 100 г" },
  { key: "price", label: "Ціна" },
  { key: "title", label: "Назва" },
];

const NUTRIENTS: { key: NutrientKey; label: string }[] = [
  { key: "kcal", label: "Калорії" },
  { key: "protein", label: "Білки" },
  { key: "fat", label: "Жири" },
  { key: "carbs", label: "Вуглеводи" },
];

interface Preset {
  key: string;
  label: string;
  desc: string;
  ranges: Partial<Record<NutrientKey, Range>>;
  density: string; // min protein per 100 kcal
  sortKey: SortKey;
  sortDir: 1 | -1;
}

// Thresholds tuned empirically against the real snapshot (see analysis).
const PRESETS: Preset[] = [
  {
    key: "cheap-protein",
    label: "Дешевий білок",
    desc: "Найбільше білка за гроші — бобові, дешеве м'ясо, консерви",
    ranges: { protein: { min: "8", max: "" } },
    density: "6",
    sortKey: "pricePerProtein",
    sortDir: 1,
  },
  {
    key: "filling",
    label: "Сито, мало калорій",
    desc: "Багато білка на калорію — морепродукти, риба, яєчний білок",
    ranges: { protein: { min: "7", max: "" }, kcal: { min: "25", max: "150" } },
    density: "",
    sortKey: "proteinPerKcal",
    sortDir: -1,
  },
  {
    key: "lean",
    label: "Білок без жиру",
    desc: "Пісний білок, відсортований за ціною за білок",
    ranges: { protein: { min: "12", max: "" }, fat: { min: "", max: "5" } },
    density: "6",
    sortKey: "pricePerProtein",
    sortDir: 1,
  },
  {
    key: "volume",
    label: "Об'ємна їжа",
    desc: "Низька калорійність на 100 г — наповнює об'ємом",
    ranges: { protein: { min: "3", max: "" }, kcal: { min: "15", max: "80" } },
    density: "",
    sortKey: "kcal",
    sortDir: 1,
  },
];

function rangesFromPreset(preset: Preset): Ranges {
  const next = emptyRanges();
  for (const k of Object.keys(preset.ranges) as NutrientKey[]) {
    next[k] = { ...emptyRange(), ...preset.ranges[k] };
  }
  return next;
}

const DEFAULT_PRESET = PRESETS[0];

// ---- Filter-state persistence (validated, restored once at startup) ----

interface SavedState {
  search: string;
  category: string;
  store: StoreFilter;
  discountOnly: boolean;
  cheaperElsewhere: boolean;
  basis: Basis;
  inStockOnly: boolean;
  hidePetFood: boolean;
  plausibleOnly: boolean;
  sortKey: SortKey;
  sortDir: 1 | -1;
  ranges: Ranges;
  minDensity: string;
  activePreset: string | null;
}

const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));

function sanitizeSaved(raw: unknown): Partial<SavedState> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<SavedState> = {};
  if (typeof r.search === "string") out.search = r.search;
  if (typeof r.category === "string") out.category = r.category;
  if (r.store === "all" || r.store === "auchan" || r.store === "silpo") out.store = r.store;
  if (typeof r.discountOnly === "boolean") out.discountOnly = r.discountOnly;
  if (typeof r.cheaperElsewhere === "boolean") out.cheaperElsewhere = r.cheaperElsewhere;
  if (typeof r.inStockOnly === "boolean") out.inStockOnly = r.inStockOnly;
  if (typeof r.hidePetFood === "boolean") out.hidePetFood = r.hidePetFood;
  if (typeof r.plausibleOnly === "boolean") out.plausibleOnly = r.plausibleOnly;
  if (r.basis === "100g" || r.basis === "pack") out.basis = r.basis;
  if (SORT_KEYS.has(r.sortKey as SortKey)) out.sortKey = r.sortKey as SortKey;
  if (r.sortDir === 1 || r.sortDir === -1) out.sortDir = r.sortDir;
  if (typeof r.minDensity === "string") out.minDensity = r.minDensity;
  // null = explicit manual mode (keep). A preset key that no longer exists
  // (removed in an update) also collapses to manual mode rather than silently
  // snapping to the default preset, which would mismatch the restored ranges.
  // undefined is left unset so a first-time visitor still gets the default preset.
  if (r.activePreset === null) out.activePreset = null;
  else if (typeof r.activePreset === "string") {
    out.activePreset = PRESETS.some((p) => p.key === r.activePreset) ? r.activePreset : null;
  }
  if (r.ranges && typeof r.ranges === "object") {
    const next = emptyRanges();
    for (const key of Object.keys(next) as NutrientKey[]) {
      const rr = (r.ranges as Record<string, unknown>)[key];
      if (rr && typeof rr === "object") {
        const { min, max } = rr as Record<string, unknown>;
        if (typeof min === "string") next[key].min = min;
        if (typeof max === "string") next[key].max = max;
      }
    }
    out.ranges = next;
  }
  return out;
}

const SAVED = sanitizeSaved(loadJSON(FILTERS_KEY));

function sortValue(p: Product, key: SortKey, basis: Basis): number | null {
  switch (key) {
    case "kcal":
    case "protein":
    case "fat":
    case "carbs":
      return nutrientValue(p, key, basis);
    case "price":
      return p.price;
    case "pricePer100":
      return pricePer100g(p);
    case "pricePerProtein":
      return pricePerProtein(p);
    case "proteinPerKcal":
      return proteinPerKcal(p);
    default:
      return null;
  }
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className={accent ? "stat accent" : "stat"}>
      <span className="stat-l">{label}</span>
      <span className="stat-v">{value}</span>
    </div>
  );
}

function hideBrokenImg(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.visibility = "hidden";
}

// Cross-store price hint: green savings chip when the same item is cheaper in
// the other store, a faint marker when this is already the cheapest.
function CrossChip({ info }: { info: CrossStoreInfo | undefined }) {
  if (!info) return null;
  if (info.isCheapest) {
    return (
      <span className="xstore best" title="Найдешевше серед магазинів">
        ✓ найдешевше
      </span>
    );
  }
  // Pricier than the other store, but by < 1% after rounding — call it a tie.
  if (info.deltaPct < 1) {
    return (
      <span className="xstore best" title={`Та сама ціна, що в ${STORE_BADGE[info.cheaperStore].label}`}>
        ≈ {STORE_BADGE[info.cheaperStore].label}
      </span>
    );
  }
  return (
    <span className="xstore cheaper" title={`Дешевше в ${STORE_BADGE[info.cheaperStore].label} на ${info.deltaPct}%`}>
      ↘ {STORE_BADGE[info.cheaperStore].label} −{info.deltaPct}%
    </span>
  );
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState(SAVED.search ?? "");
  const [category, setCategory] = useState<string>(SAVED.category ?? "all");
  const [store, setStore] = useState<StoreFilter>(SAVED.store ?? "auchan");
  const [discountOnly, setDiscountOnly] = useState(SAVED.discountOnly ?? false);
  const [cheaperElsewhere, setCheaperElsewhere] = useState(SAVED.cheaperElsewhere ?? false);
  const [basis, setBasis] = useState<Basis>(SAVED.basis ?? "100g");
  const [inStockOnly, setInStockOnly] = useState(SAVED.inStockOnly ?? true);
  const [hidePetFood, setHidePetFood] = useState(SAVED.hidePetFood ?? true);
  const [plausibleOnly, setPlausibleOnly] = useState(SAVED.plausibleOnly ?? false);
  const [sortKey, setSortKey] = useState<SortKey>(SAVED.sortKey ?? DEFAULT_PRESET.sortKey);
  const [sortDir, setSortDir] = useState<1 | -1>(SAVED.sortDir ?? DEFAULT_PRESET.sortDir);
  const [ranges, setRanges] = useState<Ranges>(() => SAVED.ranges ?? rangesFromPreset(DEFAULT_PRESET));
  const [minDensity, setMinDensity] = useState(SAVED.minDensity ?? DEFAULT_PRESET.density);
  const [activePreset, setActivePreset] = useState<string | null>(
    SAVED.activePreset !== undefined ? SAVED.activePreset : DEFAULT_PRESET.key
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [altFor, setAltFor] = useState<Product | null>(null);
  // Initial theme is whatever the no-FOUC inline script already put on <html>.
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
  );
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Last query already written to history — dedupes the settle-debounce against
  // Enter/click so the same query isn't persisted twice.
  const lastCommittedRef = useRef("");

  const isMobile = useIsMobile();

  // Compact summary of the currently-active filters, stored with a search so the
  // history dropdown can show what was filtered besides the query text.
  function currentFilterSummary(): string {
    const parts: string[] = [];
    if (store !== "all") parts.push(store === "auchan" ? "Ашан" : "Сільпо");
    for (const b of activeBadges) parts.push(b.label);
    return parts.join(" · ");
  }

  const commitToHistory = (raw: string) => {
    const q = raw.trim();
    if (q.length < 2 || q === lastCommittedRef.current) return;
    lastCommittedRef.current = q;
    setHistory(pushHistory(q, currentFilterSummary()));
  };

  // Persist filter state (debounced — range inputs change on every keystroke).
  useEffect(() => {
    const state: SavedState = {
      search,
      category,
      store,
      discountOnly,
      cheaperElsewhere,
      basis,
      inStockOnly,
      hidePetFood,
      plausibleOnly,
      sortKey,
      sortDir,
      ranges,
      minDensity,
      activePreset,
    };
    const t = setTimeout(() => saveJSON(FILTERS_KEY, state), 250);
    return () => clearTimeout(t);
  }, [search, category, store, discountOnly, cheaperElsewhere, basis, inStockOnly, hidePetFood, plausibleOnly, sortKey, sortDir, ranges, minDensity, activePreset]);

  // Reflect theme changes onto <html> and persist the explicit choice.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  // A restored category may no longer exist in a fresh snapshot.
  useEffect(() => {
    if (categories.length && category !== "all" && !categories.some((c) => c.id === category)) {
      setCategory("all");
    }
  }, [categories, category]);

  // Commit the query to search history once typing settles.
  useEffect(() => {
    const t = setTimeout(() => commitToHistory(search), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    Promise.all([
      fetch(`${base}data/products.json`).then((r) => r.json()),
      fetch(`${base}data/categories.json`).then((r) => r.json()),
      fetch(`${base}data/meta.json`).then((r) => r.json()),
    ])
      .then(([p, c, m]) => {
        setProducts(p);
        setCategories(c);
        setMeta(m);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const visibleCategories = useMemo(() => {
    return categories
      .map((c) => ({ ...c, count: store === "all" ? c.count : (c.counts[store] ?? 0) }))
      .filter((c) => c.count > 0 && !(hidePetFood && c.id === PET_FOOD_CAT));
  }, [categories, hidePetFood, store]);

  // Heavy indexes (search vocabulary ~16k tokens, cross-store equivalence over
  // 34k products) are built AFTER the catalog first paints, so initial render
  // isn't blocked by ~300ms of indexing. Until they arrive the matcher is null
  // (no search filtering) and the cross-store map is empty (no chips) — both
  // are already guarded everywhere they're read.
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [crossStore, setCrossStore] = useState<Map<string, CrossStoreInfo>>(() => new Map());
  useEffect(() => {
    if (!products.length) return;
    const t = setTimeout(() => {
      setSearchIndex(buildSearchIndex(products));
      setCrossStore(buildCrossStore(products));
    }, 0);
    return () => clearTimeout(t);
  }, [products]);

  // One pass produces both the visible list and per-category hit counts (the
  // category filter is applied last, so the counts cover all other filters).
  const { filtered, catHits } = useMemo(() => {
    const matcher = searchIndex ? createMatcher(searchIndex, search) : null;
    const dens = minDensity === "" ? null : parseFloat(minDensity);
    const rangeNums = NUTRIENTS.map(({ key }) => {
      const r = ranges[key];
      const min = r.min === "" ? null : parseFloat(r.min);
      const max = r.max === "" ? null : parseFloat(r.max);
      return { key, min: Number.isNaN(min as number) ? null : min, max: Number.isNaN(max as number) ? null : max };
    });

    const catHits = new Map<string, number>();
    const list: Product[] = [];
    outer: for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (store !== "all" && p.store !== store) continue;
      if (discountOnly && p.oldPrice == null) continue;
      if (cheaperElsewhere) {
        const ci = crossStore.get(p.id);
        if (!ci || ci.isCheapest || ci.deltaPct < 1) continue; // only meaningfully cheaper elsewhere
      }
      if (hidePetFood && p.cat === PET_FOOD_CAT) continue;
      if (inStockOnly && !p.inStock) continue;
      if (plausibleOnly && !isPlausible(p)) continue;
      if (dens != null && !Number.isNaN(dens)) {
        const d = proteinPerKcal(p);
        if (d == null || d < dens) continue;
      }
      if (matcher && !matcher(i)) continue;
      for (const r of rangeNums) {
        if (r.min == null && r.max == null) continue;
        const v = p[r.key]; // per 100 g — canonical for range filtering
        if (v == null) continue outer;
        if (r.min != null && v < r.min) continue outer;
        if (r.max != null && v > r.max) continue outer;
      }
      catHits.set(p.cat, (catHits.get(p.cat) || 0) + 1);
      if (category !== "all" && p.cat !== category) continue;
      list.push(p);
    }

    list.sort((a, b) => {
      if (sortKey === "title") return a.title.localeCompare(b.title, "uk") * sortDir;
      return compareNullable(sortValue(a, sortKey, basis), sortValue(b, sortKey, basis), sortDir);
    });
    return { filtered: list, catHits };
  }, [products, searchIndex, crossStore, search, category, store, discountOnly, cheaperElsewhere, inStockOnly, hidePetFood, plausibleOnly, minDensity, ranges, sortKey, sortDir, basis]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    for (const k of Object.keys(ranges) as NutrientKey[]) {
      if (ranges[k].min !== "") n++;
      if (ranges[k].max !== "") n++;
    }
    if (minDensity !== "") n++;
    if (category !== "all") n++;
    if (discountOnly) n++;
    if (cheaperElsewhere) n++;
    return n;
  }, [ranges, minDensity, category, discountOnly, cheaperElsewhere]);

  const searchActive = search.trim().length > 0;

  // Category blocks shown instead of the plain results count while searching.
  const catBlocks = useMemo(() => {
    if (!searchActive) return [];
    return visibleCategories
      .map((c) => ({ ...c, hits: catHits.get(c.id) ?? 0 }))
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.hits - a.hits);
  }, [visibleCategories, catHits, searchActive]);

  // Removable badges for the active filters (mobile quick-glance row).
  const activeBadges = useMemo(() => {
    const out: { key: string; label: string; clear: () => void }[] = [];
    if (category !== "all") {
      const c = categories.find((x) => x.id === category);
      out.push({ key: "cat", label: c?.title ?? "Категорія", clear: () => setCategory("all") });
    }
    if (discountOnly) out.push({ key: "disc", label: "Зі знижкою", clear: () => setDiscountOnly(false) });
    if (cheaperElsewhere) out.push({ key: "cheaper", label: "Дешевше деінде", clear: () => setCheaperElsewhere(false) });
    if (minDensity !== "") {
      out.push({
        key: "dens",
        label: `Б/100ккал ≥ ${minDensity}`,
        clear: () => {
          setMinDensity("");
          setActivePreset(null);
        },
      });
    }
    for (const { key, label } of NUTRIENTS) {
      const r = ranges[key];
      if (r.min === "" && r.max === "") continue;
      const suffix = r.min !== "" && r.max !== "" ? `${r.min}–${r.max}` : r.min !== "" ? `від ${r.min}` : `до ${r.max}`;
      out.push({
        key,
        label: `${label} ${suffix}`,
        clear: () => {
          setRanges((x) => ({ ...x, [key]: emptyRange() }));
          setActivePreset(null);
        },
      });
    }
    return out;
  }, [category, categories, discountOnly, cheaperElsewhere, minDensity, ranges]);

  // When a search returns nothing, tell apart a misspelled term (→ offer
  // spelling suggestions) from over-tight filters (→ offer to clear them).
  const emptyState = useMemo(() => {
    if (!searchActive || filtered.length > 0 || !searchIndex) return null;
    const matcher = createMatcher(searchIndex, search);
    let termMatches = false;
    if (matcher) {
      for (let i = 0; i < products.length; i++)
        if (matcher(i)) {
          termMatches = true;
          break;
        }
    }
    if (termMatches) return { kind: "filters" as const, suggestions: [] as string[] };
    return { kind: "term" as const, suggestions: suggestTerms(searchIndex, search) };
  }, [searchActive, filtered.length, searchIndex, search, products]);

  const emptyBlock =
    filtered.length === 0 ? (
      <div className="empty">
        {emptyState?.kind === "term" && emptyState.suggestions.length > 0 ? (
          <>
            <p>
              Нічого не знайдено за запитом «{search.trim()}».
            </p>
            <p className="muted">Можливо, ви мали на увазі:</p>
            <div className="suggest-chips">
              {emptyState.suggestions.map((s) => (
                <button key={s} className="suggest-chip" onClick={() => onManualFilterChange(() => setSearch(s))}>
                  {s}
                </button>
              ))}
            </div>
          </>
        ) : emptyState?.kind === "filters" ? (
          <>
            <p>За запитом «{search.trim()}» товари є, але їх приховують фільтри.</p>
            <button className="link" onClick={clearFilters}>
              Скинути фільтри
            </button>
          </>
        ) : (
          "Нічого не знайдено — спробуйте змінити фільтри."
        )}
      </div>
    ) : null;

  // Active-filter bar shown above the table: every applied filter as a chip you
  // can remove one by one (to widen a range / see what's actually filtering),
  // plus a single "clear all". Lives here so it's visible on desktop and mobile.
  const filterBar =
    activeBadges.length > 0 ? (
      <div className="filter-bar">
        {activeBadges.map((b) => (
          <button key={b.key} className="fbadge" onClick={b.clear} title={`Прибрати: ${b.label}`}>
            {b.label}
            <span className="fbadge-x">✕</span>
          </button>
        ))}
        <button className="fbadge-clear" onClick={clearFilters}>
          Очистити все
        </button>
      </div>
    ) : null;

  // Healthier same-family alternatives for the product whose panel is open.
  const alternatives = useMemo(() => (altFor ? findHealthier(products, altFor) : []), [altFor, products]);

  const historyItems = useMemo(() => {
    const trimmed = search.trim();
    const q = trimmed.toLowerCase();
    return history.filter((h) => h.q !== trimmed && (q === "" || h.q.toLowerCase().includes(q))).slice(0, 8);
  }, [history, search]);

  function toggleSort(key: SortKey) {
    setActivePreset(null);
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(ASC_DEFAULT.has(key) ? 1 : -1);
    }
  }

  function applyPreset(preset: Preset) {
    // Second click on the active scenario toggles it off — clearing only what
    // the scenario applied (its nutrient ranges + density floor) while keeping
    // the chosen category and other state intact.
    if (activePreset === preset.key) {
      setRanges(emptyRanges());
      setMinDensity("");
      setActivePreset(null);
      return;
    }
    setRanges(rangesFromPreset(preset));
    setMinDensity(preset.density);
    setSortKey(preset.sortKey);
    setSortDir(preset.sortDir);
    setActivePreset(preset.key);
  }

  // Clear every filter except the search text.
  function clearFilters() {
    setCategory("all");
    setDiscountOnly(false);
    setCheaperElsewhere(false);
    setRanges(emptyRanges());
    setMinDensity("");
    setActivePreset(null);
  }

  function resetFilters() {
    setSearch("");
    clearFilters();
  }

  function onManualFilterChange(updater: () => void) {
    updater();
    setActivePreset(null);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isMobile ? CARD_H : ROW_H),
    overscan: isMobile ? 6 : 12,
  });
  // Re-measure cached row sizes when switching between table rows and cards.
  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  if (error) {
    return (
      <div className="state">
        <h1>Помилка завантаження</h1>
        <p>{error}</p>
        <p className="muted">Згенеруйте дані: <code>npm run scrape</code>, потім перезапустіть.</p>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="state">
        <div className="spinner" />
        <p>Завантаження каталогу…</p>
      </div>
    );
  }

  // In the drawer a category tap applies instantly and dismisses the menu.
  const selectCategory = (id: string, inDrawer: boolean) => {
    setCategory(id);
    if (inDrawer) setDrawerOpen(false);
  };

  const renderSidebar = (inDrawer: boolean) => (
    <>
      <section>
        <h2>Магазин</h2>
        <div className="basis-toggle">
          {STORE_OPTIONS.map((o) => (
            <button key={o.key} className={store === o.key ? "seg active" : "seg"} onClick={() => setStore(o.key)}>
              {o.label}
            </button>
          ))}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={discountOnly} onChange={(e) => setDiscountOnly(e.target.checked)} />
          Лише зі знижкою
        </label>
        <label className="checkbox" title="Той самий товар (бренд, фасування) дешевший в іншому магазині">
          <input
            type="checkbox"
            checked={cheaperElsewhere}
            onChange={(e) => setCheaperElsewhere(e.target.checked)}
          />
          Дешевше в іншому магазині
        </label>
      </section>

      <section>
        <h2>Категорії</h2>
        <ul className="cat-list">
          <li>
            <button className={category === "all" ? "cat active" : "cat"} onClick={() => selectCategory("all", inDrawer)}>
              <span>Усі категорії</span>
            </button>
          </li>
          {visibleCategories.map((c) => (
            <li key={c.id}>
              <button
                className={category === c.id ? "cat active" : "cat"}
                onClick={() => selectCategory(c.id, inDrawer)}
                title={c.title}
              >
                <span className="cat-name">{c.title}</span>
                <span className="count">{c.count.toLocaleString("uk-UA")}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Сценарії</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={activePreset === p.key ? "preset active" : "preset"}
              onClick={() => applyPreset(p)}
              title={p.desc}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Фільтри (на 100 г)</h2>
        <div className="range">
          <label>Білок на 100 ккал ≥</label>
          <div className="range-inputs">
            <input
              type="number"
              placeholder="напр. 6"
              value={minDensity}
              onChange={(e) => onManualFilterChange(() => setMinDensity(e.target.value))}
            />
          </div>
        </div>
        {NUTRIENTS.map(({ key, label }) => (
          <div className="range" key={key}>
            <label>{label}</label>
            <div className="range-inputs">
              <input
                type="number"
                placeholder="від"
                value={ranges[key].min}
                onChange={(e) =>
                  onManualFilterChange(() => setRanges((r) => ({ ...r, [key]: { ...r[key], min: e.target.value } })))
                }
              />
              <input
                type="number"
                placeholder="до"
                value={ranges[key].max}
                onChange={(e) =>
                  onManualFilterChange(() => setRanges((r) => ({ ...r, [key]: { ...r[key], max: e.target.value } })))
                }
              />
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2>Відображення</h2>
        <div className="basis-toggle">
          <button className={basis === "100g" ? "seg active" : "seg"} onClick={() => setBasis("100g")}>
            на 100 г
          </button>
          <button className={basis === "pack" ? "seg active" : "seg"} onClick={() => setBasis("pack")}>
            на упаковку
          </button>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} />
          Лише в наявності
        </label>
      </section>

      <section>
        <h2>Якість даних</h2>
        <label className="checkbox">
          <input type="checkbox" checked={hidePetFood} onChange={(e) => setHidePetFood(e.target.checked)} />
          Сховати корм для тварин
        </label>
        <label className="checkbox" title="Ховає товари, де заявлені ккал не сходяться з 4·білки+9·жири+4·вугл (Atwater)">
          <input type="checkbox" checked={plausibleOnly} onChange={(e) => setPlausibleOnly(e.target.checked)} />
          Лише правдоподібні дані
        </label>
      </section>
    </>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🥦</span>
          <div>
            <h1>Каталог за КБЖУ · Львів</h1>
            <p className="muted">
              {meta.stores.map((s) => s.title).join(" + ")} · {meta.totalKept.toLocaleString("uk-UA")} товарів ·
              оновлено {new Date(meta.generatedAt).toLocaleDateString("uk-UA")}
            </p>
          </div>
        </div>
        <div className="search-wrap">
          <input
            className="search"
            type="search"
            placeholder="Пошук за назвою або брендом…"
            value={search}
            onChange={(e) => onManualFilterChange(() => setSearch(e.target.value))}
            onFocus={() => setHistoryOpen(true)}
            onBlur={() => setHistoryOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitToHistory(search);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setHistoryOpen(false);
              }
            }}
          />
          {historyOpen && historyItems.length > 0 && (
            <div className="search-history">
              {historyItems.map((h) => (
                <button
                  key={h.q}
                  className="hist-item"
                  // mousedown (not click) so it fires before the input's blur
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onManualFilterChange(() => setSearch(h.q));
                    commitToHistory(h.q);
                    setHistoryOpen(false);
                  }}
                >
                  <span className="hist-icon">↺</span>
                  <span className="hist-q">{h.q}</span>
                  {h.f && <span className="hist-f">{h.f}</span>}
                </button>
              ))}
              <button
                className="hist-clear"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setHistory(clearHistory());
                }}
              >
                Очистити історію
              </button>
            </div>
          )}
        </div>
        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          title={theme === "dark" ? "Світла тема" : "Темна тема"}
          aria-label="Перемкнути тему"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      <div className="layout">
        {!isMobile && <aside className="sidebar">{renderSidebar(false)}</aside>}

        <main className="results">
          {isMobile && (
            <div className="m-controls">
              <div className="chips">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className={activePreset === p.key ? "chip active" : "chip"}
                    onClick={() => applyPreset(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="m-bar">
                <button className="m-filters-btn" onClick={() => setDrawerOpen(true)}>
                  Фільтри{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
                </button>
                <select
                  className="m-sort"
                  value={sortKey}
                  onChange={(e) => {
                    const k = e.target.value as SortKey;
                    setSortKey(k);
                    setSortDir(ASC_DEFAULT.has(k) ? 1 : -1);
                    setActivePreset(null);
                  }}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  className="m-dir"
                  onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}
                  title="Напрямок сортування"
                >
                  {sortDir === -1 ? "↓" : "↑"}
                </button>
              </div>
            </div>
          )}

          {filterBar}

          {searchActive && catBlocks.length > 0 ? (
            <div className="cat-hits">
              {catBlocks.map((c) => (
                <button
                  key={c.id}
                  className={category === c.id ? "cat-hit active" : "cat-hit"}
                  onClick={() => setCategory(category === c.id ? "all" : c.id)}
                  title={c.title}
                >
                  {c.img ? <img src={c.img} alt="" loading="lazy" onError={hideBrokenImg} /> : <div className="noimg" />}
                  <span className="cat-hit-title">{c.title}</span>
                  <span className="cat-hit-count">{c.hits.toLocaleString("uk-UA")}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="results-head">
              <strong>{filtered.length.toLocaleString("uk-UA")}</strong> товарів
              {basis === "pack" && <span className="muted"> · значення на упаковку</span>}
            </div>
          )}

          {isMobile ? (
            <div className="cards-scroll" ref={scrollRef}>
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const p = filtered[vi.index];
                  return (
                    <article
                      key={p.id}
                      className={p.inStock ? "m-card" : "m-card out"}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <div className="m-card-head">
                        {p.img ? (
                          <img src={p.img} alt="" loading="lazy" onError={hideBrokenImg} />
                        ) : (
                          <div className="noimg" />
                        )}
                        <div className="m-card-title">
                          <a href={p.url ?? "#"} target="_blank" rel="noreferrer" className="ttl">
                            {p.title}
                          </a>
                          <div className="sub">
                            {store === "all" && (
                              <span className={STORE_BADGE[p.store].cls}>{STORE_BADGE[p.store].label}</span>
                            )}
                            {!p.inStock && <span className="oos">немає</span>}
                            <CrossChip info={crossStore.get(p.id)} />
                            <button className="alt-btn" onClick={() => setAltFor(p)} title="Знайти корисніші варіанти">
                              🥗 заміна
                            </button>
                            {p.brand && <span className="brand">{p.brand}</span>}
                            <span className="weight">{fmtWeight(p)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="m-stats">
                        <Stat label="Ккал" value={fmt(nutrientValue(p, "kcal", basis), 0)} />
                        <Stat label="Білки" value={fmt(nutrientValue(p, "protein", basis))} />
                        <Stat label="Жири" value={fmt(nutrientValue(p, "fat", basis))} />
                        <Stat label="Вугл." value={fmt(nutrientValue(p, "carbs", basis))} />
                        <Stat label="Б/100к" value={fmt(proteinPerKcal(p))} accent />
                        <Stat label="₴/100гБ" value={fmtPrice(pricePerProtein(p))} accent />
                        <Stat label="₴/100г" value={fmtPrice(pricePer100g(p))} />
                        <Stat
                          label="Ціна"
                          value={
                            <>
                              {p.oldPrice != null && <span className="old-price">{fmtPrice(p.oldPrice)}</span>}
                              <span className={p.oldPrice != null ? "discount-price" : undefined}>
                                {fmtPrice(p.price)}
                              </span>
                              {(p.unit === "kg" || p.unit === "l") && (
                                <span className="per-unit">/{p.unit === "kg" ? "кг" : "л"}</span>
                              )}
                            </>
                          }
                        />
                      </div>
                    </article>
                  );
                })}
              </div>
              {emptyBlock}
            </div>
          ) : (
            <div className="table">
              <div className="table-scroll" ref={scrollRef}>
                <div className="table-inner">
                  <div className="thead" style={{ gridTemplateColumns: GRID }}>
                    <div className="th th-img" />
                    {COLUMNS.map((col) => (
                      <div
                        key={col.key}
                        className={`th sortable ${col.align === "right" ? "right" : ""} ${sortKey === col.key ? "sorted" : ""}`}
                        title={col.title}
                        onClick={() => toggleSort(col.key)}
                      >
                        {col.label}
                        {sortKey === col.key && <span className="arrow">{sortDir === -1 ? "▼" : "▲"}</span>}
                      </div>
                    ))}
                  </div>

                  <div className="virtual-area" style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                    {rowVirtualizer.getVirtualItems().map((vi) => {
                      const p = filtered[vi.index];
                      return (
                        <div
                          key={p.id}
                          className={p.inStock ? "tr" : "tr out"}
                          style={{
                            gridTemplateColumns: GRID,
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${vi.start}px)`,
                          }}
                        >
                          <div className="td td-img">
                            {p.img ? (
                              <img src={p.img} alt="" loading="lazy" onError={hideBrokenImg} />
                            ) : (
                              <div className="noimg" />
                            )}
                          </div>
                          <div className="td td-title">
                            <a href={p.url ?? "#"} target="_blank" rel="noreferrer" className="ttl">
                              {p.title}
                            </a>
                            <div className="sub">
                              {store === "all" && (
                                <span className={STORE_BADGE[p.store].cls}>{STORE_BADGE[p.store].label}</span>
                              )}
                              {!p.inStock && <span className="oos">немає</span>}
                              <CrossChip info={crossStore.get(p.id)} />
                              <button className="alt-btn" onClick={() => setAltFor(p)} title="Знайти корисніші варіанти">
                                🥗 заміна
                              </button>
                              {p.brand && <span className="brand">{p.brand}</span>}
                              <span className="path">{p.path}</span>
                              <span className="weight">{fmtWeight(p)}</span>
                            </div>
                          </div>
                          <div className="td right">{fmt(nutrientValue(p, "kcal", basis), 0)}</div>
                          <div className="td right">{fmt(nutrientValue(p, "protein", basis))}</div>
                          <div className="td right">{fmt(nutrientValue(p, "fat", basis))}</div>
                          <div className="td right">{fmt(nutrientValue(p, "carbs", basis))}</div>
                          <div className="td right accent">{fmt(proteinPerKcal(p))}</div>
                          <div className="td right accent">{fmtPrice(pricePerProtein(p))}</div>
                          <div className="td right">{fmtPrice(pricePer100g(p))}</div>
                          <div className="td right">
                            {p.oldPrice != null && <span className="old-price">{fmtPrice(p.oldPrice)}</span>}
                            <span className={p.oldPrice != null ? "discount-price" : undefined}>{fmtPrice(p.price)}</span>
                            {(p.unit === "kg" || p.unit === "l") && (
                              <span className="per-unit">/{p.unit === "kg" ? "кг" : "л"}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {emptyBlock}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {isMobile && drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <strong>Фільтри та категорії</strong>
              <button className="drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Закрити">
                ✕
              </button>
            </div>
            <div className="drawer-body">{renderSidebar(true)}</div>
            <div className="drawer-foot">
              <button className="drawer-clear" onClick={resetFilters}>
                Очистити
              </button>
              <button className="drawer-apply" onClick={() => setDrawerOpen(false)}>
                Показати {filtered.length.toLocaleString("uk-UA")}
              </button>
            </div>
          </div>
        </div>
      )}

      {altFor && (
        <div className="modal-backdrop" onClick={() => setAltFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <strong>Корисніша заміна</strong>
              <button className="drawer-close" onClick={() => setAltFor(null)} aria-label="Закрити">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="alt-source">
                <div className="alt-name">{altFor.title}</div>
                <div className="alt-metrics">
                  <span className={STORE_BADGE[altFor.store].cls}>{STORE_BADGE[altFor.store].label}</span>
                  <span>
                    Б/100ккал <b>{fmt(proteinPerKcal(altFor))}</b>
                  </span>
                  <span>{fmt(altFor.kcal, 0)} ккал</span>
                  <span>{fmtPrice(pricePer100g(altFor))}/100г</span>
                </div>
              </div>

              {alternatives.length > 0 ? (
                <>
                  <p className="muted alt-hint">Більше білка на калорію у тій самій категорії:</p>
                  <ul className="alt-list">
                    {alternatives.map((a) => (
                      <li key={a.product.id} className="alt-item">
                        {a.product.img ? (
                          <img src={a.product.img} alt="" loading="lazy" onError={hideBrokenImg} />
                        ) : (
                          <div className="noimg" />
                        )}
                        <div className="alt-item-main">
                          <a href={a.product.url ?? "#"} target="_blank" rel="noreferrer" className="ttl">
                            {a.product.title}
                          </a>
                          <div className="alt-item-sub">
                            <span className={STORE_BADGE[a.product.store].cls}>{STORE_BADGE[a.product.store].label}</span>
                            <span className="alt-density">Б/100ккал {fmt(a.density)}</span>
                            <span>{fmt(a.product.kcal, 0)} ккал</span>
                            {a.cheaper === true && <span className="alt-cheaper">дешевший білок</span>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted alt-hint">Це вже один із найбілковіших варіантів у своїй категорії.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const GRID = "48px minmax(220px, 1fr) 70px 70px 70px 70px 88px 92px 96px 84px";
