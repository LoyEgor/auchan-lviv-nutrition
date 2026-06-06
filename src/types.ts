export interface Product {
  id: string;
  title: string;
  cat: string; // top-level category id
  catTitle: string;
  path: string; // full category path, " / " joined
  price: number | null; // UAH
  weight: number | null; // grams, when known
  volume: number | null; // ml, when known
  unit: string | null;
  kcal: number | null; // per 100 g
  protein: number | null; // per 100 g
  fat: number | null; // per 100 g
  carbs: number | null; // per 100 g
  brand: string | null;
  img: string | null;
  url: string | null;
  inStock: boolean;
}

export interface Category {
  id: string;
  title: string;
  count: number;
}

export interface Meta {
  store: string;
  storeId: string;
  generatedAt: string;
  totalSeen: number;
  totalKept: number;
  withKcal: number;
  withProtein: number;
  withFat: number;
  withCarbs: number;
  full4: number;
}

export type NutrientKey = "kcal" | "protein" | "fat" | "carbs";
export type Basis = "100g" | "pack";
