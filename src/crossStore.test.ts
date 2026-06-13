import { describe, expect, it } from "vitest";
import type { Product } from "./types";
import { buildCrossStore } from "./crossStore";

let seq = 0;
function product(over: Partial<Product>): Product {
  return {
    id: `p${seq++}`,
    store: "auchan",
    title: "товар",
    cat: "dairy-eggs",
    path: "",
    price: 10,
    oldPrice: null,
    weight: 100,
    volume: null,
    unit: "pcs",
    kcal: null,
    protein: null,
    fat: null,
    carbs: null,
    brand: "President",
    img: null,
    url: null,
    inStock: true,
    ...over,
  };
}

describe("buildCrossStore", () => {
  it("matches the same item across stores and flags the cheaper one", () => {
    const a = product({ store: "auchan", title: "Сир кисломолочний President 9% 180г", weight: 180, price: 63.9 });
    const s = product({ store: "silpo", title: "Сир кисломолочний President 9%", weight: 180, price: 54.5 });
    const map = buildCrossStore([a, s]);

    expect(map.has(a.id)).toBe(true);
    expect(map.has(s.id)).toBe(true);
    expect(map.get(s.id)!.isCheapest).toBe(true);
    expect(map.get(a.id)!.cheaperStore).toBe("silpo");
    // 63.9/180*100 = 35.5 vs 54.5/180*100 = 30.3 → ~17% more
    expect(map.get(a.id)!.deltaPct).toBeGreaterThan(10);
    expect(map.get(s.id)!.deltaPct).toBe(0);
  });

  it("does not match across different pack sizes (size bucket)", () => {
    const a = product({ store: "auchan", title: "Молоко Яготинське 2,5%", weight: 900, price: 40 });
    const s = product({ store: "silpo", title: "Молоко Яготинське 2,5%", weight: 1000, price: 42 });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });

  it("does not match different fat-content variants (pct bucket)", () => {
    const a = product({ store: "auchan", title: "Сир кисломолочний President 5% 300г", weight: 300, price: 60 });
    const s = product({ store: "silpo", title: "Сир кисломолочний President 9% 300г", weight: 300, price: 65 });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });

  it("treats brandless 'без ТМ' as no brand (no false staple matches)", () => {
    const a = product({ store: "auchan", title: "Огірок короткоплідний", brand: "без тм", unit: "kg", weight: null });
    const s = product({ store: "silpo", title: "Огірок Рівненський короткоплідний", brand: "Без ТМ", unit: "kg", weight: null });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });

  it("does not match different flavors of the same brand/size", () => {
    const a = product({ store: "auchan", title: "Йогурт活іа полуниця 260г", brand: "Activia", weight: 260 });
    const s = product({ store: "silpo", title: "Йогурт Activia персик 260г", brand: "Activia", weight: 260 });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });

  it("ignores single-store buckets", () => {
    const a = product({ store: "auchan", title: "Сир President 9%", weight: 180, price: 50 });
    const b = product({ store: "auchan", title: "Сир President 9%", weight: 180, price: 60 });
    const map = buildCrossStore([a, b]);
    expect(map.size).toBe(0);
  });

  it("requires a brand to match", () => {
    const a = product({ store: "auchan", title: "Огірок", brand: null, unit: "kg", weight: null });
    const s = product({ store: "silpo", title: "Огірок", brand: null, unit: "kg", weight: null });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });

  it("compares weight-priced (kg) goods of the same brand fairly", () => {
    const a = product({ store: "auchan", title: "Філе куряче Наша Ряба", brand: "Наша Ряба", unit: "kg", weight: null, price: 200 });
    const s = product({ store: "silpo", title: "Філе куряче охолоджене Наша Ряба", brand: "Наша Ряба", unit: "kg", weight: null, price: 180 });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(2);
    expect(map.get(s.id)!.isCheapest).toBe(true);
    expect(map.get(a.id)!.cheaperStore).toBe("silpo");
  });

  it("skips products without a comparable price", () => {
    const a = product({ store: "auchan", title: "Сир President 9%", weight: 180, price: null });
    const s = product({ store: "silpo", title: "Сир President 9%", weight: 180, price: 50 });
    const map = buildCrossStore([a, s]);
    expect(map.size).toBe(0);
  });
});
