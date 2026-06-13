// Character-level folding that collapses Ukrainian/Russian spelling variants
// into one canonical form before matching. Russian speakers searching a
// Ukrainian catalog routinely swap і/и, є/е, ї/і, type ы/э/ё from the Russian
// layout, or drop the apostrophe (мясо → м'ясо). Folding both the index and
// the query makes all of those compare equal, and the remaining differences
// (e.g. RU "хлеб" vs UK "хліб") are left to the weighted edit distance.

const FOLD: Record<string, string> = {
  і: "и",
  ї: "и",
  ы: "и",
  // Latin i inside Cyrillic words is a common Ukrainian brand affectation
  // ("Молокiя"). Folding it on both sides keeps pure-Latin tokens consistent.
  i: "и",
  є: "е",
  э: "е",
  ё: "е",
  ґ: "г",
  // Soft/hard signs and apostrophes carry no value for matching: сіль/соль
  // fold to сил/сол, м'ясо/мясо fold identically.
  ь: "",
  ъ: "",
  "'": "",
  "’": "",
  ʼ: "",
  "`": "",
};

export function fold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) out += FOLD[ch] ?? ch;
  return out;
}

// Tokens are runs of folded Cyrillic, Latin or digits — brand names and
// numbers ("9%") count. Everything else (punctuation, %, units glued by
// spaces) separates tokens.
const TOKEN_RE = /[a-z0-9а-яёіїєґ]+/g;

export function tokenize(s: string): string[] {
  return fold(s).match(TOKEN_RE) ?? [];
}

// Like tokenize, but also returns each token's original (lowercased) surface
// form, so the search index can show human-readable suggestions instead of the
// folded shape ("олія", not "олия"). Apostrophes stay inside a word so "м'ясо"
// is one token whose folded form is "мясо".
const SURFACE_RE = /[a-z0-9а-яёіїєґ'’ʼ`]+/g;

export function tokenizeSurface(s: string): { folded: string; surface: string }[] {
  const out: { folded: string; surface: string }[] = [];
  const matches = s.toLowerCase().match(SURFACE_RE);
  if (!matches) return out;
  for (const surface of matches) {
    const folded = fold(surface);
    if (folded) out.push({ folded, surface });
  }
  return out;
}
