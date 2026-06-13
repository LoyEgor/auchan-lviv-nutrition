// RU → UK lexical bridge for food queries. Character folding plus fuzzy
// matching covers same-root spelling differences (хлеб→хліб, сок→сік,
// кефир→кефір), so this dictionary only carries words that differ entirely —
// the russicisms / lexical gaps a Russian speaker is most likely to type into
// a Ukrainian grocery search (творог, клубника, огурец…), incl. common
// inflected forms. Keys and translations are folded at module init; a
// multi-word translation means "all of these words must match".
//
// A query word still matches its own literal form too, so entries never hide
// direct hits — they only add alternatives.

import { fold, tokenize } from "./fold";
import { maxCostFor, prefixDistance } from "./distance";

const RAW_DICT: Record<string, string[]> = {
  // dairy
  творог: ["сир кисломолочний", "кисломолочний"],
  творога: ["сир кисломолочний", "кисломолочний"],
  творожок: ["сирок"],
  творожный: ["сирковий"],
  творожная: ["сиркова"],
  творожное: ["сиркове"],
  сливки: ["вершки"],
  сливок: ["вершки"],
  сливочное: ["вершкове"],
  сливочный: ["вершковий"],
  сливочная: ["вершкова"],
  молочка: ["молочний", "молочна", "молоко"],
  сгущенка: ["згущене молоко", "згущене"],
  сгущенное: ["згущене"],
  // meat & fish
  ветчина: ["шинка"],
  ветчины: ["шинка"],
  говядина: ["яловичина"],
  говядины: ["яловичина"],
  говяжий: ["яловичий"],
  говяжья: ["яловича"],
  курица: ["курка", "курятина"],
  курицы: ["курка", "курятина"],
  куриное: ["куряче"],
  куриная: ["куряча"],
  куриный: ["курячий"],
  куриные: ["курячі"],
  сельдь: ["оселедець"],
  селедка: ["оселедець"],
  селедки: ["оселедець"],
  // vegetables & herbs
  лук: ["цибуля"],
  лука: ["цибуля"],
  картофель: ["картопля"],
  картофеля: ["картопля"],
  картошка: ["картопля"],
  картошки: ["картопля"],
  свекла: ["буряк"],
  свеклы: ["буряк"],
  тыква: ["гарбуз"],
  тыквы: ["гарбуз"],
  огурец: ["огірок"],
  огурцы: ["огірки", "огірок"],
  огурцов: ["огірки", "огірок"],
  морковь: ["морква"],
  морковка: ["морква"],
  моркови: ["морква"],
  укроп: ["кріп"],
  укропа: ["кріп"],
  сельдерей: ["селера"],
  шампиньоны: ["печериці"],
  шампиньон: ["печериця"],
  вешенки: ["гливи"],
  опята: ["опеньки"],
  цветная: ["цвітна"],
  // fruits & berries
  клубника: ["полуниця"],
  клубники: ["полуниця"],
  клубничный: ["полуничний"],
  земляника: ["суниця"],
  арбуз: ["кавун"],
  арбуза: ["кавун"],
  персики: ["персики"],
  крыжовник: ["аґрус"],
  клюква: ["журавлина"],
  клюквы: ["журавлина"],
  черника: ["чорниця"],
  черники: ["чорниця"],
  голубика: ["лохина"],
  ежевика: ["ожина"],
  изюм: ["родзинки"],
  изюма: ["родзинки"],
  // grocery & baking
  мука: ["борошно"],
  муки: ["борошно"],
  сахар: ["цукор"],
  сахара: ["цукор"],
  семечки: ["насіння"],
  хлопья: ["пластівці"],
  хлопьев: ["пластівці"],
  овсянка: ["вівсянка"],
  овсянки: ["вівсянка"],
  овсяные: ["вівсяні"],
  овсяная: ["вівсяна"],
  овсяное: ["вівсяне"],
  овсяный: ["вівсяний"],
  гречневая: ["гречана"],
  гречневые: ["гречані"],
  гречневый: ["гречаний"],
  ржаной: ["житній"],
  ржаная: ["житня"],
  ржаное: ["житнє"],
  дрожжи: ["дріжджі"],
  лапша: ["локшина"],
  лапши: ["локшина"],
  фасоль: ["квасоля"],
  фасоли: ["квасоля"],
  чечевица: ["сочевиця"],
  чечевицы: ["сочевиця"],
  орех: ["горіх"],
  орехи: ["горіхи"],
  орехов: ["горіхи"],
  грецкий: ["волоський", "грецький"],
  уксус: ["оцет"],
  подсолнечное: ["соняшникова олія", "соняшникове"],
  подсолнечная: ["соняшникова"],
  растительное: ["олія"],
  масло: ["масло", "олія"],
  масла: ["масло", "олія"],
  // sweets & desserts
  конфеты: ["цукерки"],
  конфет: ["цукерки"],
  печенье: ["печиво"],
  печенья: ["печиво"],
  мороженое: ["морозиво"],
  мороженого: ["морозиво"],
  пирожное: ["тістечко"],
  пирожные: ["тістечка", "тістечко"],
  // drinks
  кофе: ["кава"],
  водка: ["горілка"],
  водки: ["горілка"],
  // ready food
  блины: ["млинці"],
  блинчики: ["млинці"],
  оладьи: ["оладки"],
};

export interface DictEntry {
  key: string; // folded RU word
  phrases: string[][]; // alternatives; each phrase is folded words, all required
  display: string[]; // original (readable) UK translations, parallel to phrases
}

export const DICT: DictEntry[] = Object.entries(RAW_DICT).map(([key, translations]) => ({
  key: fold(key),
  phrases: translations.map((t) => tokenize(t)),
  display: translations,
}));

// Alternative phrases for a (folded) query word. Keys are matched with the
// same fuzzy/prefix rule as catalog tokens, so typos and partly typed
// russicisms still reach their translations (клубни → полуниця) — but only
// the closest key(s) win. Without that, a fuzzy hit on an unrelated key would
// pollute results (мука differs from лука by one letter, and must not pull in
// цибуля alongside борошно).
export function dictAlternatives(word: string): string[][] {
  let best = Infinity;
  let out: string[][] = [];
  const cap = maxCostFor(word);
  for (const entry of DICT) {
    const d = entry.key.startsWith(word) ? 0 : cap > 0 ? prefixDistance(word, entry.key, cap) : Infinity;
    if (d === Infinity || d > best) continue;
    if (d < best) {
      best = d;
      out = [];
    }
    out.push(...entry.phrases);
  }
  return out;
}
