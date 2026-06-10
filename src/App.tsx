import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Product, Category, Meta, NutrientKey, Basis } from "./types";
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

type SortKey = "title" | NutrientKey | "price" | "pricePer100" | "pricePerProtein" | "proteinPerKcal";
type Range = { min: string; max: string };
const emptyRange = (): Range => ({ min: "", max: "" });
type Ranges = Record<NutrientKey, Range>;
const emptyRanges = (): Ranges => ({ kcal: emptyRange(), protein: emptyRange(), fat: emptyRange(), carbs: emptyRange() });

const PET_FOOD_CAT = "for-animals-auchan";
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

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [basis, setBasis] = useState<Basis>("100g");
  const [inStockOnly, setInStockOnly] = useState(true);
  const [hidePetFood, setHidePetFood] = useState(true);
  const [plausibleOnly, setPlausibleOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_PRESET.sortKey);
  const [sortDir, setSortDir] = useState<1 | -1>(DEFAULT_PRESET.sortDir);
  const [ranges, setRanges] = useState<Ranges>(() => rangesFromPreset(DEFAULT_PRESET));
  const [minDensity, setMinDensity] = useState(DEFAULT_PRESET.density);
  const [activePreset, setActivePreset] = useState<string | null>(DEFAULT_PRESET.key);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isMobile = useIsMobile();

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

  const visibleCategories = useMemo(
    () => categories.filter((c) => !(hidePetFood && c.id === PET_FOOD_CAT)),
    [categories, hidePetFood]
  );

  const filtered = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const dens = minDensity === "" ? null : parseFloat(minDensity);
    const rangeNums = NUTRIENTS.map(({ key }) => {
      const r = ranges[key];
      const min = r.min === "" ? null : parseFloat(r.min);
      const max = r.max === "" ? null : parseFloat(r.max);
      return { key, min: Number.isNaN(min as number) ? null : min, max: Number.isNaN(max as number) ? null : max };
    });

    const out = products.filter((p) => {
      if (category !== "all" && p.cat !== category) return false;
      if (hidePetFood && p.cat === PET_FOOD_CAT) return false;
      if (inStockOnly && !p.inStock) return false;
      if (plausibleOnly && !isPlausible(p)) return false;
      if (dens != null && !Number.isNaN(dens)) {
        const d = proteinPerKcal(p);
        if (d == null || d < dens) return false;
      }
      if (words.length) {
        const hay = `${p.title} ${p.brand ?? ""} ${p.path}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      for (const r of rangeNums) {
        if (r.min == null && r.max == null) continue;
        const v = p[r.key]; // per 100 g — canonical for range filtering
        if (v == null) return false;
        if (r.min != null && v < r.min) return false;
        if (r.max != null && v > r.max) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      if (sortKey === "title") return a.title.localeCompare(b.title, "uk") * sortDir;
      return compareNullable(sortValue(a, sortKey, basis), sortValue(b, sortKey, basis), sortDir);
    });
    return out;
  }, [products, search, category, inStockOnly, hidePetFood, plausibleOnly, minDensity, ranges, sortKey, sortDir, basis]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    for (const k of Object.keys(ranges) as NutrientKey[]) {
      if (ranges[k].min !== "") n++;
      if (ranges[k].max !== "") n++;
    }
    if (minDensity !== "") n++;
    if (category !== "all") n++;
    return n;
  }, [ranges, minDensity, category]);

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
    setRanges(rangesFromPreset(preset));
    setMinDensity(preset.density);
    setSortKey(preset.sortKey);
    setSortDir(preset.sortDir);
    setActivePreset(preset.key);
  }

  function resetFilters() {
    setSearch("");
    setCategory("all");
    setRanges(emptyRanges());
    setMinDensity("");
    setActivePreset(null);
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

  const sidebarSections = (
    <>
      <section>
        <h2>Категорії</h2>
        <ul className="cat-list">
          <li>
            <button className={category === "all" ? "cat active" : "cat"} onClick={() => setCategory("all")}>
              <span>Усі категорії</span>
            </button>
          </li>
          {visibleCategories.map((c) => (
            <li key={c.id}>
              <button
                className={category === c.id ? "cat active" : "cat"}
                onClick={() => setCategory(c.id)}
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
        <div className="section-head">
          <h2>Сценарії</h2>
          <button className="link" onClick={resetFilters}>
            Скинути
          </button>
        </div>
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
            <h1>Ашан Львів · каталог за КБЖУ</h1>
            <p className="muted">
              {meta.store} · {meta.totalKept.toLocaleString("uk-UA")} товарів з даними · оновлено{" "}
              {new Date(meta.generatedAt).toLocaleDateString("uk-UA")}
            </p>
          </div>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Пошук за назвою або брендом…"
          value={search}
          onChange={(e) => onManualFilterChange(() => setSearch(e.target.value))}
        />
      </header>

      <div className="layout">
        {!isMobile && <aside className="sidebar">{sidebarSections}</aside>}

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

          <div className="results-head">
            <strong>{filtered.length.toLocaleString("uk-UA")}</strong> товарів
            {basis === "pack" && <span className="muted"> · значення на упаковку</span>}
          </div>

          {isMobile ? (
            <div className="cards-scroll" ref={scrollRef}>
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const p = filtered[vi.index];
                  return (
                    <article
                      key={p.id}
                      className="m-card"
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
                              {fmtPrice(p.price)}
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
              {filtered.length === 0 && <div className="empty">Нічого не знайдено — спробуйте змінити фільтри.</div>}
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
                          className="tr"
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
                            {fmtPrice(p.price)}
                            {(p.unit === "kg" || p.unit === "l") && (
                              <span className="per-unit">/{p.unit === "kg" ? "кг" : "л"}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {filtered.length === 0 && <div className="empty">Нічого не знайдено — спробуйте змінити фільтри.</div>}
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
            <div className="drawer-body">{sidebarSections}</div>
            <button className="drawer-apply" onClick={() => setDrawerOpen(false)}>
              Показати {filtered.length.toLocaleString("uk-UA")} товарів
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const GRID = "48px minmax(220px, 1fr) 70px 70px 70px 70px 88px 92px 96px 84px";
