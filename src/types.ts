export type StoreId = "auchan" | "silpo";

export interface Product {
  id: string;
  store: StoreId;
  title: string;
  cat: string; // unified category id
  path: string; // store-native category path, " / " joined
  price: number | null; // UAH; per kg/l for unit "kg"/"l" goods
  oldPrice: number | null; // UAH, pre-discount price when discounted
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
  counts: Partial<Record<StoreId, number>>;
  img: string | null;
}

export interface StoreMeta {
  store: StoreId;
  title: string;
  storeRef: string;
  generatedAt: string;
  totalSeen: number;
  totalKept: number;
  withKcal: number;
  withProtein: number;
  withFat: number;
  withCarbs: number;
  full4: number;
  withDiscount: number;
}

export interface Meta {
  generatedAt: string;
  totalSeen: number;
  totalKept: number;
  withKcal: number;
  withProtein: number;
  withFat: number;
  withCarbs: number;
  full4: number;
  withDiscount: number;
  stores: StoreMeta[];
}

export type NutrientKey = "kcal" | "protein" | "fat" | "carbs";
export type Basis = "100g" | "pack";
