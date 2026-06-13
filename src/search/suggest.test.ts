import { describe, expect, it } from "vitest";
import { buildSearchIndex } from "./index";
import { suggestTerms } from "./suggest";

const products = [
  { title: "Сир кисломолочний President 9% 300г", brand: "President", path: "Молочне / Сир кисломолочний" },
  { title: "Полуниця свіжа", brand: null, path: "Фрукти та овочі / Ягоди" },
  { title: "Олія соняшникова Олейна 1л", brand: "Олейна", path: "Бакалія / Олія" },
  { title: "Молоко Яготинське 2,5% 900г", brand: "Яготинське", path: "Молочне / Молоко" },
  { title: "Йогурт Активіа натуральний 2,7%", brand: "Активіа", path: "Молочне / Йогурти" },
];
const index = buildSearchIndex(products);

describe("suggestTerms", () => {
  it("suggests a close catalog term for a typo", () => {
    // "полунеця" → полуниця (one substitution beyond the strict matcher)
    const s = suggestTerms(index, "полунеця");
    expect(s).toContain("полуниця");
  });

  it("shows readable surface forms, not folded shapes", () => {
    // "олея" → олія (must display with і, not the folded "олия")
    const s = suggestTerms(index, "олея");
    expect(s).toContain("олія");
    expect(s.some((x) => x.includes("олия"))).toBe(false);
  });

  it("bridges a misspelled russicism to its Ukrainian term", () => {
    // "клубнека" is far from any catalog token, but close to dict key "клубника"
    const s = suggestTerms(index, "клубнека");
    expect(s).toContain("полуниця");
  });

  it("replaces only the misspelled word in a multi-word query", () => {
    const s = suggestTerms(index, "молоко ягтинське");
    expect(s.some((x) => x.startsWith("молоко "))).toBe(true);
    expect(s.some((x) => /яготинське/i.test(x))).toBe(true);
  });

  it("returns nothing for empty, too-short, or already-matching input", () => {
    expect(suggestTerms(index, "")).toEqual([]);
    expect(suggestTerms(index, "ї")).toEqual([]);
    // exact existing token shouldn't suggest itself
    expect(suggestTerms(index, "полуниця")).not.toContain("полуниця");
  });

  it("does not crash on a long nonsense query", () => {
    expect(() => suggestTerms(index, "я".repeat(300))).not.toThrow();
  });
});
