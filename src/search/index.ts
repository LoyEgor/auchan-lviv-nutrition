// Fuzzy product search tuned for a Ukrainian catalog queried by users who mix
// Russian spellings, letter confusions and typos. The pipeline:
//
//   1. fold.ts     — collapse UK/RU letter variants (і/и, є/е, ы, apostrophes…)
//   2. distance.ts — bounded weighted prefix distance for what folding can't
//                    (хлеб→хліб, сок→сік, plain typos, transpositions)
//   3. dict.ts     — lexical bridge for words that differ entirely
//                    (творог→сир кисломолочний, клубника→полуниця…)
//
// Matching is a filter (the app sorts by nutrition, not relevance): a product
// matches when EVERY query word matches — directly against one of the
// product's tokens, or through one of its dictionary translations (a
// multi-word translation requires all of its words).
//
// Words are matched against the global token vocabulary once per distinct
// word (memoized), then products are tested via precomputed token-id lists —
// fast enough to run on every keystroke over ~35k products.

import { tokenize, tokenizeSurface } from "./fold";
import { maxCostFor, prefixDistance } from "./distance";
import { dictAlternatives } from "./dict";

export { suggestTerms } from "./suggest";

export interface SearchIndex {
  vocab: string[];
  productTokens: number[][];
  flagCache: Map<string, Uint8Array>;
  // Folded token -> a representative original spelling, for readable suggestions.
  surfaceOf: Map<string, string>;
}

export interface Searchable {
  title: string;
  brand: string | null;
  path: string;
}

export function buildSearchIndex(products: Searchable[]): SearchIndex {
  const vocabId = new Map<string, number>();
  const vocab: string[] = [];
  const surfaceOf = new Map<string, string>();
  const productTokens = products.map((p) => {
    const ids: number[] = [];
    for (const { folded, surface } of tokenizeSurface(`${p.title} ${p.brand ?? ""} ${p.path}`)) {
      let id = vocabId.get(folded);
      if (id == null) {
        id = vocab.length;
        vocab.push(folded);
        vocabId.set(folded, id);
      }
      // Prefer a clean alphabetic surface (skip pure-digit/short noise) once.
      if (!surfaceOf.has(folded)) surfaceOf.set(folded, surface);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  });
  return { vocab, productTokens, flagCache: new Map(), surfaceOf };
}

// Vocabulary tokens matching one (folded) query word, as a flag array.
function wordFlags(index: SearchIndex, word: string): Uint8Array {
  const cached = index.flagCache.get(word);
  if (cached) return cached;
  const { vocab } = index;
  const flags = new Uint8Array(vocab.length);
  const cap = maxCostFor(word);
  for (let i = 0; i < vocab.length; i++) {
    const t = vocab[i];
    if (t.startsWith(word)) flags[i] = 1;
    else if (cap > 0 && prefixDistance(word, t, cap) !== Infinity) flags[i] = 1;
  }
  if (index.flagCache.size > 300) index.flagCache.clear();
  index.flagCache.set(word, flags);
  return flags;
}

function hasAny(flags: Uint8Array, tokenIds: number[]): boolean {
  for (const id of tokenIds) if (flags[id]) return true;
  return false;
}

interface WordPlan {
  direct: Uint8Array;
  phrases: Uint8Array[][]; // alternatives from the dictionary; all words of one phrase required
}

// Build a predicate over product indices for a free-text query, or null when
// the query has no usable tokens (≙ no filtering).
export function createMatcher(index: SearchIndex, query: string): ((productIndex: number) => boolean) | null {
  const words = tokenize(query);
  if (!words.length) return null;

  const plans: WordPlan[] = words.map((w) => ({
    direct: wordFlags(index, w),
    phrases: dictAlternatives(w).map((phrase) => phrase.map((u) => wordFlags(index, u))),
  }));

  return (productIndex: number) => {
    const tokenIds = index.productTokens[productIndex];
    for (const plan of plans) {
      if (hasAny(plan.direct, tokenIds)) continue;
      let ok = false;
      for (const phrase of plan.phrases) {
        if (phrase.every((flags) => hasAny(flags, tokenIds))) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    return true;
  };
}
