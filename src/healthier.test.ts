import { describe, expect, it } from "vitest";
import type { Product } from "./types";
import { findHealthier } from "./healthier";

let seq = 0;
function product(over: Partial<Product>): Product {
  return {
    id: `p${seq++}`,
    store: "auchan",
    title: "товар",
    cat: "dairy-eggs",
    path: "",
    price: 30,
    oldPrice: null,
    weight: 100,
    volume: null,
    unit: "pcs",
    kcal: 100,
    protein: 5,
    fat: 3,
    carbs: 10,
    brand: null,
    img: null,
    url: null,
    inStock: true,
    ...over,
  };
}

describe("findHealthier", () => {
  it("suggests a leaner same-family item (more protein per calorie)", () => {
    // sugary yogurt: density = 4/90*100 = 4.4
    const source = product({ title: "Йогурт полуничний", kcal: 90, protein: 4 });
    // protein yogurt: density = 10/60*100 = 16.7  (same family: "йогурт")
    const lean = product({ title: "Йогурт протеїновий натуральний", kcal: 60, protein: 10 });
    const alts = findHealthier([source, lean], source);
    expect(alts.map((a) => a.product.id)).toContain(lean.id);
  });

  it("does not suggest a different food family even if leaner", () => {
    const source = product({ title: "Йогурт полуничний", kcal: 90, protein: 4 });
    // leaner, same category, but no shared title token → not a swap
    const cheese = product({ title: "Сир твердий Гауда", kcal: 350, protein: 25 });
    const alts = findHealthier([source, cheese], source);
    expect(alts).toEqual([]);
  });

  it("respects the store mode (single store suggests only that store)", () => {
    const source = product({ store: "auchan", title: "Йогурт полуничний", kcal: 90, protein: 4 });
    const leanSilpo = product({ store: "silpo", title: "Йогурт протеїновий натуральний", kcal: 60, protein: 10 });
    // store mode = Auchan only → the leaner Silpo item must not be offered
    expect(findHealthier([source, leanSilpo], source, "auchan")).toEqual([]);
    // both stores → it is offered
    expect(findHealthier([source, leanSilpo], source, "all").map((a) => a.product.id)).toContain(leanSilpo.id);
  });

  it("does not suggest items outside the category", () => {
    const source = product({ title: "Йогурт полуничний", kcal: 90, protein: 4 });
    const otherCat = product({ title: "Йогурт соєвий", cat: "healthy", kcal: 50, protein: 9 });
    expect(findHealthier([source, otherCat], source)).toEqual([]);
  });

  it("ignores near-zero-calorie density artifacts", () => {
    const source = product({ title: "Йогурт полуничний", kcal: 90, protein: 4 });
    // 'йогуртовий' tea-like product with almost no calories → huge density, junk
    const fake = product({ title: "Йогуртовий ароматизатор", kcal: 5, protein: 2 });
    expect(findHealthier([source, fake], source)).toEqual([]);
  });

  it("requires a meaningful density gain (not marginally leaner)", () => {
    const source = product({ title: "Йогурт натуральний", kcal: 100, protein: 5 }); // density 5
    const marginal = product({ title: "Йогурт натуральний легкий", kcal: 100, protein: 5.5 }); // density 5.5 (<1.2x)
    expect(findHealthier([source, marginal], source)).toEqual([]);
  });

  it("flags whether the alternative is also cheaper per gram of protein", () => {
    const source = product({ title: "Йогурт полуничний", kcal: 90, protein: 4, price: 30, weight: 100 });
    const lean = product({ title: "Йогурт протеїновий", kcal: 60, protein: 10, price: 30, weight: 100 });
    const alts = findHealthier([source, lean], source);
    expect(alts[0].cheaper).toBe(true); // more protein at same price → cheaper per protein
  });

  it("returns nothing when the source has no nutrition data", () => {
    const source = product({ title: "Йогурт", kcal: null, protein: null });
    const lean = product({ title: "Йогурт протеїновий", kcal: 60, protein: 10 });
    expect(findHealthier([source, lean], source)).toEqual([]);
  });
});
