// Minimal localStorage persistence. Storage may be unavailable (private mode,
// disabled cookies) or full — every operation degrades to a no-op then.

export const FILTERS_KEY = "food.filters.v1";
const HISTORY_KEY = "food.history.v2";
const HISTORY_MAX = 10;

// Theme is stored as a raw string ("light"/"dark"), NOT JSON, so the no-FOUC
// inline script in index.html can read it with a plain getItem comparison.
export const THEME_KEY = "food.theme.v1";
export type Theme = "light" | "dark";

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore — persistence is best-effort
  }
}

export function loadJSON<T>(key: string): T | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null; // storage unavailable (private mode, disabled) — expected
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // Corrupted value (not just absent) — surface it, then fall back to defaults.
    console.warn(`Discarding corrupted localStorage entry "${key}":`, e);
    return null;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore — persistence is best-effort
  }
}

// A past search: the query plus a SNAPSHOT of the filters that were active when
// it ran. The snapshot is both shown in the dropdown and re-applied on click, so
// what you see in history is exactly what you get — no drift between the two.
export interface HistoryFilters {
  category: string;
  store: "all" | "auchan" | "silpo";
  discountOnly: boolean;
  cheaperElsewhere: boolean;
  completeOnly: boolean;
  minDensity: string;
  minPrice: string;
  maxPrice: string;
  ranges: Record<string, { min: string; max: string }>;
}
export interface HistoryEntry {
  q: string;
  filters: HistoryFilters;
}

function sanitizeFilters(raw: unknown): HistoryFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ranges: HistoryFilters["ranges"] = {};
  if (r.ranges && typeof r.ranges === "object") {
    for (const [k, v] of Object.entries(r.ranges as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const { min, max } = v as Record<string, unknown>;
        ranges[k] = { min: typeof min === "string" ? min : "", max: typeof max === "string" ? max : "" };
      }
    }
  }
  return {
    category: typeof r.category === "string" ? r.category : "all",
    store: r.store === "auchan" || r.store === "silpo" ? r.store : "all",
    discountOnly: r.discountOnly === true,
    cheaperElsewhere: r.cheaperElsewhere === true,
    completeOnly: r.completeOnly === true,
    minDensity: typeof r.minDensity === "string" ? r.minDensity : "",
    minPrice: typeof r.minPrice === "string" ? r.minPrice : "",
    maxPrice: typeof r.maxPrice === "string" ? r.maxPrice : "",
    ranges,
  };
}

export function loadHistory(): HistoryEntry[] {
  const raw = loadJSON<unknown>(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const x of raw) {
    if (x && typeof x === "object" && typeof (x as any).q === "string") {
      out.push({ q: (x as any).q, filters: sanitizeFilters((x as any).filters) });
    }
  }
  return out.slice(0, HISTORY_MAX);
}

// Most-recent-first, deduplicated by query, capped. Returns the updated list.
export function pushHistory(query: string, filters: HistoryFilters): HistoryEntry[] {
  const q = query.trim();
  const next = [{ q, filters }, ...loadHistory().filter((h) => h.q !== q)].slice(0, HISTORY_MAX);
  saveJSON(HISTORY_KEY, next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  saveJSON(HISTORY_KEY, []);
  return [];
}
