// "Did you mean" suggestions for a query that matched nothing. Reuses the same
// machinery as search: the longest query word is treated as the likely culprit,
// and the closest catalog vocabulary terms (plus RU→UK dictionary hits, which
// are guaranteed to resolve to real products) are offered as replacements. Each
// suggestion is a full query string with the culprit word swapped, ready to put
// straight back into the search box.

import { fold, tokenizeSurface } from "./fold";
import { prefixDistance } from "./distance";
import { DICT } from "./dict";
import type { SearchIndex } from "./index";

// A more forgiving budget than search uses — suggestions should reach a bit
// further than a strict match would.
function suggestCap(word: string): number {
  return Math.max(2, Math.ceil(word.length / 2));
}

export function suggestTerms(index: SearchIndex, query: string, limit = 6): string[] {
  const surfaceWords = tokenizeSurface(query);
  if (!surfaceWords.length) return [];

  // The longest word carries the most meaning and is the usual typo target.
  let ti = 0;
  for (let i = 1; i < surfaceWords.length; i++) {
    if (surfaceWords[i].folded.length > surfaceWords[ti].folded.length) ti = i;
  }
  const target = surfaceWords[ti].folded;
  if (target.length < 3) return [];
  const cap = suggestCap(target);

  // candidate display text -> best (lowest) distance found for it
  const best = new Map<string, number>();
  const consider = (display: string, dist: number) => {
    if (!display || dist > cap) return;
    const prev = best.get(display);
    if (prev == null || dist < prev) best.set(display, dist);
  };

  // Catalog vocabulary: the surface (readable) form is what we show.
  for (const tok of index.vocab) {
    if (tok === target || Math.abs(tok.length - target.length) > cap) continue;
    const d = prefixDistance(target, tok, cap);
    if (d !== Infinity && d > 0) consider(index.surfaceOf.get(tok) ?? tok, d);
  }

  // Dictionary keys: a near-miss russicism suggests its UK translation, which is
  // guaranteed searchable. A small penalty keeps exact vocabulary hits ahead.
  for (const entry of DICT) {
    const d = prefixDistance(target, entry.key, cap);
    if (d !== Infinity && entry.display[0]) consider(entry.display[0], d + 0.25);
  }

  const ranked = [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([display]) => display);

  // Rebuild the full query with the culprit word replaced; drop duplicates and
  // anything identical to what the user already typed.
  const original = surfaceWords.map((w) => w.surface);
  const normalizedQuery = fold(query.trim());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const display of ranked) {
    const phrase = original.map((w, i) => (i === ti ? display : w)).join(" ");
    const key = fold(phrase);
    if (key === normalizedQuery || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}
