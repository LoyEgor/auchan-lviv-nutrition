// Bounded, weighted Damerau-Levenshtein prefix distance for UK/RU matching.
//
// "Prefix" means the candidate token may extend beyond the query word for
// free, so a partially typed word matches ("молок" → "молоко", "молокопродукт").
//
// Two language-specific rules tune precision/recall:
// - Substitutions inside the confusable vowel class {е, и, о, й} cost 0.5
//   instead of 1 — after folding, RU↔UK same-root pairs differ exactly there
//   (хлеб/хліб, сок/сік, сёмга/сьомга, лёд/льод), and so do the common typos.
// - Full-cost edits are forbidden in the first two letters: people get word
//   starts right, and without this "мука" reaches "мака(рони)" and "хлеб"
//   reaches "хребет". Cheap substitutions and transpositions stay allowed.

const CHEAP_CLASS = new Set(["е", "и", "о", "й"]);

function subCost(a: string, b: string): number {
  if (a === b) return 0;
  return CHEAP_CLASS.has(a) && CHEAP_CLASS.has(b) ? 0.5 : 1;
}

// Maximum allowed cost for a query word of the given length.
export function maxCostFor(word: string): number {
  // Digit-only words (weights, percentages) must match exactly.
  if (/^\d+$/.test(word)) return 0;
  const n = word.length;
  if (n <= 2) return 0; // too short to fuzz — prefix match only
  if (n === 3) return 0.5; // exactly one confusable substitution (сок → сік)
  if (n <= 6) return 1; // one typo (яйца → яйця), keeps молоко from молодий
  if (n <= 8) return 1.5; // индейка → індичка, овсянка → вівсянка
  return 2;
}

// Distance from `word` to the closest prefix of `token`, capped at `maxCost`
// (returns Infinity when it exceeds the cap). Insertions/deletions cost 1,
// adjacent transpositions cost 1, confusable substitutions cost 0.5.
export function prefixDistance(word: string, token: string, maxCost: number): number {
  if (token.startsWith(word)) return 0;
  const m = word.length;
  // Cells beyond the band |i - j| > band can never get back under maxCost.
  const band = Math.floor(maxCost) + 1;
  const lim = Math.min(token.length, m + band);
  if (lim < m - band) return Infinity;

  let prev: number[] = new Array(lim + 1);
  let prevPrev: number[] | null = null;
  // Row 0: turning the empty word into token[0..j-1] costs j insertions.
  // In prefix mode the token may extend past the word for free — that freedom
  // is taken at the end by minimizing over the whole last row, not here.
  for (let j = 0; j <= lim; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    const cur: number[] = new Array(lim + 1);
    cur[0] = i;
    let rowMin = cur[0];
    const wc = word[i - 1];
    for (let j = 1; j <= lim; j++) {
      if (Math.abs(i - j) > band) {
        cur[j] = Infinity;
        continue;
      }
      const tc = token[j - 1];
      const sub = subCost(wc, tc);
      // Full-cost edits are not allowed within the first two letters.
      let v = sub <= 0.5 || (i > 2 && j > 2) ? prev[j - 1] + sub : Infinity;
      if (i > 2) v = Math.min(v, prev[j] + 1); // delete from word
      if (j > 2) v = Math.min(v, cur[j - 1] + 1); // insert into word
      if (i > 1 && j > 1 && wc === token[j - 2] && word[i - 2] === tc && prevPrev) {
        v = Math.min(v, prevPrev[j - 2] + 1); // transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxCost) return Infinity;
    prevPrev = prev;
    prev = cur;
  }

  // Prefix mode: the word must be consumed, the token may go on. The answer is
  // the best cost of turning the word into ANY prefix of the token.
  let best = Infinity;
  for (let j = 0; j <= lim; j++) if (prev[j] < best) best = prev[j];
  return best <= maxCost ? best : Infinity;
}

// Convenience predicate used both for catalog tokens and dictionary keys.
export function wordMatchesToken(word: string, token: string): boolean {
  if (token.startsWith(word)) return true;
  const cap = maxCostFor(word);
  if (cap === 0) return false;
  return prefixDistance(word, token, cap) !== Infinity;
}
