// Minimal localStorage persistence. Storage may be unavailable (private mode,
// disabled cookies) or full — every operation degrades to a no-op then.

export const FILTERS_KEY = "food.filters.v1";
const HISTORY_KEY = "food.history.v1";
const HISTORY_MAX = 10;

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

export function loadHistory(): string[] {
  const raw = loadJSON<unknown>(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string").slice(0, HISTORY_MAX);
}

// Most-recent-first, deduplicated, capped. Returns the updated list.
export function pushHistory(query: string): string[] {
  const q = query.trim();
  const next = [q, ...loadHistory().filter((h) => h !== q)].slice(0, HISTORY_MAX);
  saveJSON(HISTORY_KEY, next);
  return next;
}

export function clearHistory(): string[] {
  saveJSON(HISTORY_KEY, []);
  return [];
}
