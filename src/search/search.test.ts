import { describe, expect, it } from "vitest";
import { fold, tokenize } from "./fold";
import { maxCostFor, prefixDistance, wordMatchesToken } from "./distance";
import { dictAlternatives } from "./dict";
import { buildSearchIndex, createMatcher } from "./index";

describe("fold", () => {
  it("collapses UK/RU letter variants", () => {
    expect(fold("Індичка")).toBe(fold("индичка"));
    expect(fold("Єгурт")).toBe(fold("егурт"));
    expect(fold("сыр")).toBe(fold("сир"));
    expect(fold("ҐУДЗИК")).toBe(fold("гудзик"));
  });

  it("drops apostrophes and soft/hard signs", () => {
    expect(fold("м'ясо")).toBe("мясо");
    expect(fold("мʼясо")).toBe("мясо");
    expect(fold("сіль")).toBe("сил");
    expect(fold("подъезд")).toBe("подезд");
  });

  it("tokenizes mixed text with brands and numbers", () => {
    // Latin i folds to Cyrillic и on both the index and query sides.
    expect(tokenize("Сир President 9% (180г)")).toEqual(["сир", "presиdent", "9", "180г"]);
    expect(fold("Молокiя")).toBe(fold("Молокія"));
  });
});

describe("prefixDistance", () => {
  it("treats a typed prefix as an exact match", () => {
    expect(prefixDistance("молок", "молоко", 2)).toBe(0);
    expect(prefixDistance("молок", "молокопродукт", 2)).toBe(0);
  });

  it("charges 0.5 for confusable substitutions", () => {
    // RU сок vs UK сік (folded to сик)
    expect(prefixDistance(fold("сок"), fold("сік"), 0.5)).toBe(0.5);
    // RU хлеб vs UK хліб
    expect(prefixDistance(fold("хлеб"), fold("хліб"), 1)).toBe(0.5);
  });

  it("does not let unrelated short words slip through", () => {
    expect(prefixDistance(fold("сік"), fold("сир"), 0.5)).toBe(Infinity);
    expect(prefixDistance(fold("сок"), fold("сир"), 0.5)).toBe(Infinity);
  });

  it("handles plain typos and transpositions within budget", () => {
    expect(prefixDistance("молако", "молоко", 1)).toBe(1); // wrong vowel
    expect(prefixDistance("омлоко", "молоко", 1)).toBe(1); // adjacent swap
    expect(prefixDistance("абвгде", "вгдабе", 1)).toBe(Infinity);
  });

  it("matches same-root RU words against UK tokens", () => {
    const cases: Array<[string, string]> = [
      ["индейка", "індичка"],
      ["печень", "печінка"],
      ["семга", "сьомга"],
      ["гречка", "гречка"],
      ["колбаса", "ковбаса"],
      ["треска", "тріска"],
      ["горчица", "гірчиця"],
    ];
    for (const [ru, uk] of cases) {
      expect(wordMatchesToken(fold(ru), fold(uk)), `${ru} → ${uk}`).toBe(true);
    }
  });

  it("forbids full-cost edits in the first two letters", () => {
    expect(wordMatchesToken(fold("мука"), fold("макарони"))).toBe(false);
    expect(wordMatchesToken(fold("хлеб"), fold("хребет"))).toBe(false);
  });

  it("requires exact prefix for digits and 1-2 letter words", () => {
    expect(maxCostFor("9")).toBe(0);
    expect(maxCostFor("по")).toBe(0);
    expect(wordMatchesToken("9", "90")).toBe(true); // prefix is still fine
    expect(wordMatchesToken("9", "19")).toBe(false);
  });
});

describe("dict", () => {
  it("bridges russicisms to Ukrainian equivalents", () => {
    expect(dictAlternatives(fold("творог"))).toContainEqual(tokenize("сир кисломолочний"));
    expect(dictAlternatives(fold("клубника"))).toContainEqual(tokenize("полуниця"));
  });

  it("reaches translations from typos and partial input", () => {
    // typo in the Russian word itself
    expect(dictAlternatives(fold("клубнека"))).toContainEqual(tokenize("полуниця"));
    // partially typed
    expect(dictAlternatives(fold("клубни"))).toContainEqual(tokenize("полуниця"));
  });
});

describe("createMatcher (integration)", () => {
  const products = [
    { title: "Сир кисломолочний President 9% 300г", brand: "President", path: "Молочне / Сир кисломолочний" },
    { title: "Полуниця свіжа", brand: null, path: "Фрукти та овочі / Ягоди" },
    { title: "Сік яблучний Sandora 1л", brand: "Sandora", path: "Напої / Соки" },
    { title: "Хліб Київхліб житній", brand: "Київхліб", path: "Хліб та випічка" },
    { title: "Огірок короткоплідний", brand: null, path: "Фрукти та овочі / Овочі" },
    { title: "Олія соняшникова Олейна 1л", brand: "Олейна", path: "Бакалія / Олія" },
    { title: "Сир твердий Гауда", brand: null, path: "Молочне / Сири тверді" },
    { title: "Морква мита", brand: null, path: "Фрукти та овочі / Овочі" },
  ];
  const index = buildSearchIndex(products);
  const titlesFor = (query: string) => {
    const m = createMatcher(index, query);
    if (!m) return products.map((p) => p.title);
    return products.filter((_, i) => m(i)).map((p) => p.title);
  };

  it("returns null matcher for empty/garbage queries", () => {
    expect(createMatcher(index, "")).toBeNull();
    expect(createMatcher(index, "  !!! ")).toBeNull();
    expect(createMatcher(index, "   ")).toBeNull();
    expect(createMatcher(index, "%#@")).toBeNull();
  });

  it("handles degenerate inputs without throwing", () => {
    // digit-only query: matched as an exact-prefix token
    expect(() => titlesFor("300")).not.toThrow();
    expect(titlesFor("300")).toContain("Сир кисломолочний President 9% 300г");
    // a very long nonsense query must simply yield nothing, fast
    const long = "я".repeat(500);
    expect(titlesFor(long)).toEqual([]);
    // many words, all required → nothing matches everything
    expect(titlesFor("сир молоко мясо риба хліб")).toEqual([]);
    // leading/trailing noise around a real word
    expect(titlesFor("  ...полуниця!!!  ")).toEqual(["Полуниця свіжа"]);
  });

  it("finds творог as сир кисломолочний but not hard cheese", () => {
    const titles = titlesFor("творог");
    expect(titles).toContain("Сир кисломолочний President 9% 300г");
    expect(titles).not.toContain("Сир твердий Гауда");
  });

  it("finds полуниця by клубника including surzhyk spelling", () => {
    expect(titlesFor("клубника")).toEqual(["Полуниця свіжа"]);
    expect(titlesFor("клубніка")).toEqual(["Полуниця свіжа"]);
  });

  it("matches same-root RU spellings", () => {
    expect(titlesFor("сок яблочный")).toEqual(["Сік яблучний Sandora 1л"]);
    expect(titlesFor("хлеб")).toContain("Хліб Київхліб житній");
    expect(titlesFor("огурец")).toEqual(["Огірок короткоплідний"]);
    expect(titlesFor("морковь")).toEqual(["Морква мита"]);
  });

  it("handles растительное масло → олія", () => {
    expect(titlesFor("подсолнечное масло")).toEqual(["Олія соняшникова Олейна 1л"]);
  });

  it("requires every query word to match", () => {
    expect(titlesFor("сир гауда")).toEqual(["Сир твердий Гауда"]);
    expect(titlesFor("сир липовий")).toEqual([]);
  });

  it("matches by brand and by partial word", () => {
    expect(titlesFor("sandora")).toEqual(["Сік яблучний Sandora 1л"]);
    expect(titlesFor("полун")).toEqual(["Полуниця свіжа"]);
  });
});
