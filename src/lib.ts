import type { Product, NutrientKey, Basis } from "./types";

// Package size in grams (or ml treated as grams for liquids), if known.
function packSize(p: Product): number | null {
  if (p.weight && p.weight > 0) return p.weight;
  if (p.volume && p.volume > 0) return p.volume; // ml ≈ g for drinks
  return null;
}

// Nutrient value for display/sort. Data is stored per 100 g.
// In "pack" basis we scale by the package size; items without a known size
// (e.g. weight-priced "kg" goods) return null and sort to the end.
export function nutrientValue(p: Product, key: NutrientKey, basis: Basis): number | null {
  const base = p[key];
  if (base == null) return null;
  if (basis === "pack") {
    const size = packSize(p);
    return size == null ? null : (base * size) / 100;
  }
  return base;
}

// Price normalized to 100 g/ml (basis-independent value-for-money comparison).
export function pricePer100g(p: Product): number | null {
  if (p.price == null) return null;
  // Weight/volume-priced goods ("kg"/"l"): the stored price is already per 1000 unit.
  if (p.unit === "kg" || p.unit === "l") return p.price / 10;
  // Packaged goods: normalize by mass, or by volume (ml) when mass is unknown.
  const size = packSize(p);
  return size == null ? null : (p.price * 100) / size;
}

// Protein per 100 kcal — "leanness" / protein density of a food. Basis-independent.
export function proteinPerKcal(p: Product): number | null {
  if (p.protein == null || p.kcal == null || p.kcal <= 0) return null;
  return (p.protein / p.kcal) * 100;
}

// Price of 100 g of pure protein — the "rational protein per money" metric.
// Lower is better. Combines the fixed pricePer100g with protein content.
export function pricePerProtein(p: Product): number | null {
  const per100 = pricePer100g(p);
  if (per100 == null || p.protein == null || p.protein <= 0) return null;
  return (per100 * 100) / p.protein;
}

// Atwater sanity check: stated kcal vs 4·protein + 9·fat + 4·carbs.
// Flags egregiously inconsistent source data (e.g. oil listed with carbs 92).
// Heuristic: items missing any macro, or with sugar alcohols/fibre, are kept.
export function isPlausible(p: Product): boolean {
  if (p.kcal == null || p.protein == null || p.fat == null || p.carbs == null) return true;
  if (p.kcal < 5) return true;
  const calc = 4 * p.protein + 9 * p.fat + 4 * p.carbs;
  return Math.abs(calc - p.kcal) / p.kcal <= 0.5;
}

const nf0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });

export function fmt(n: number | null, digits: 0 | 1 = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return (digits === 0 ? nf0 : nf1).format(n);
}

export function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return `${nf1.format(n)} ₴`;
}

export function fmtWeight(p: Product): string {
  if (p.unit === "kg") return "за кг";
  if (p.unit === "l") return "за л";
  if (p.weight && p.weight > 0) {
    return p.weight >= 1000 ? `${fmt(p.weight / 1000)} кг` : `${fmt(p.weight, 0)} г`;
  }
  if (p.volume && p.volume > 0) {
    return p.volume >= 1000 ? `${fmt(p.volume / 1000)} л` : `${fmt(p.volume, 0)} мл`;
  }
  return p.unit === "pcs" ? "шт" : "—";
}

// Generic ascending comparator that always pushes nulls to the end.
export function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  const an = a == null || Number.isNaN(a);
  const bn = b == null || Number.isNaN(b);
  if (an && bn) return 0;
  if (an) return 1; // nulls last regardless of direction
  if (bn) return -1;
  return (a - b) * dir;
}
