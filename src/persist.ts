// Minimal localStorage persistence. Storage may be unavailable (private mode,
// disabled cookies) or full — every operation degrades to a no-op then.

export const FILTERS_KEY = "food.filters.v1";
const HISTORY_KEY = "food.history.v1";
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

// A past search: the query plus a short, human-readable summary of the filters
// that were active when it was run ("" when none).
export interface HistoryEntry {
  q: string;
  f: string;
}

export function loadHistory(): HistoryEntry[] {
  const raw = loadJSON<unknown>(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const x of raw) {
    // Tolerate the older string-only shape so existing history isn't lost.
    if (typeof x === "string") out.push({ q: x, f: "" });
    else if (x && typeof x === "object" && typeof (x as any).q === "string") {
      out.push({ q: (x as any).q, f: typeof (x as any).f === "string" ? (x as any).f : "" });
    }
  }
  return out.slice(0, HISTORY_MAX);
}

// Most-recent-first, deduplicated by query, capped. Returns the updated list.
export function pushHistory(query: string, filters = ""): HistoryEntry[] {
  const q = query.trim();
  const next = [{ q, f: filters }, ...loadHistory().filter((h) => h.q !== q)].slice(0, HISTORY_MAX);
  saveJSON(HISTORY_KEY, next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  saveJSON(HISTORY_KEY, []);
  return [];
}
