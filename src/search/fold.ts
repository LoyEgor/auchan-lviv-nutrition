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

// Phonetic Cyrillic→Latin transliteration of a FOLDED word. Catalog brands are
// stored mostly in their Latin spelling (President, Jacobs, Haribo…), which a
// Cyrillic query can never reach through folding alone. The output is matched
// against the vocabulary with the same fuzzy prefix distance, so near-misses
// (президент→prezident≈president, джакобс→jakobs≈jacobs) still resolve.
// х→h and дж→j follow how brands actually romanize, not the official standard.
const TRANSLIT: Record<string, string> = {
  щ: "shch", ж: "zh", х: "h", ч: "ch", ш: "sh", ц: "ts", ю: "yu", я: "ya", й: "y",
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", з: "z", и: "i", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
};

export function translitToLatin(folded: string): string {
  let out = "";
  for (let i = 0; i < folded.length; i++) {
    if (folded[i] === "д" && folded[i + 1] === "ж") {
      out += "j"; // дж → j (Jacobs, Jaffa…)
      i++;
      continue;
    }
    out += TRANSLIT[folded[i]] ?? folded[i];
  }
  return out;
}

export const hasCyrillic = (s: string): boolean => /[а-я]/.test(s);
