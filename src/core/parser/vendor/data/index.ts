// Vendored from Exiled Exchange 2 (https://github.com/Kvan7/Exiled-Exchange-2)
// Source: renderer/src/assets/data/index.ts @ cca30662bf31eaf38bd711e2ec1a6b899a06c40e - MIT License, see THIRD_PARTY_NOTICES.md
// POEvaluator changes (marked "POEvaluator:" below):
// - data comes from strings passed to `init` (read from disk by the adapter) instead of fetch();
// - the prebuilt fnv1a `*.index.bin` lookups are replaced by in-memory Maps built at init;
// - client strings come from a typed TS module instead of a dynamic import of client_strings.js;
// - trade-site data (`useTradeData`, network) is not loaded: TRADE_* lookups keep their
//   "not found" defaults; item drop / patrons data is not loaded.
import type {
  BaseType,
  DropEntry,
  AugmentDataByAugment,
  AugmentDataByTradeId,
  Stat,
  StatMatcher,
  TranslationDict,
  AugmentGroup,
  CatalystGroup,
} from "./interfaces";
// POEvaluator: static typed client strings instead of loadClientStrings()
import CLIENT_STRINGS_EN from "./client-strings.en";
import { ItemCategory } from "../parser/meta";
import { ItemRarity } from "../parser/ParsedItem";

export * from "./interfaces";

export let ITEM_DROP: DropEntry[];
export let CLIENT_STRINGS: TranslationDict;
export let CLIENT_STRINGS_REF: TranslationDict;
export let APP_PATRONS: Array<{ from: string; months: number; style: number }>;
export let AUGMENT_DATA_BY_AUGMENT: AugmentDataByAugment;
export let AUGMENT_DATA_BY_TRADE_ID: AugmentDataByTradeId;

export const HIGH_VALUE_AUGMENTS_HARDCODED = new Set<string>([]);
export let GROUPED_AUGMENTS: AugmentGroup<BaseType> = {
  Rune: {
    Lesser: [],
    Normal: [],
    Greater: [],
    Perfect: [],
    Other: [],
  },
  Legacy: [],
  SoulCore: {
    Normal: [],
    Special: [],
  },
  Idol: [],
  Other: [],
};
export let CATALYST_TYPES: CatalystGroup<BaseType[]> = {
  Normal: [],
  Refined: [],
};

export let CATALYST_TO_TAG: Record<string, string[]> = {};
export let TAG_TO_CATALYST: Record<string, string> = {};

export let ITEM_BY_TRANSLATED: (
  ns: BaseType["namespace"],
  name: string,
) => BaseType[] | undefined = () => undefined;
export let ITEM_BY_REF: (
  ns: BaseType["namespace"],
  name: string,
) => BaseType[] | undefined = () => undefined;
export let ITEMS_ITERATOR: (
  includes: string,
  andIncludes?: string[],
) => Generator<BaseType> = function* () {};

export let GEM_NS_NAMES: () => Generator<string> = function* () {};
export let UNIQUE_NS_NAMES: () => Generator<string> = function* () {};
export let ITEM_NS_NAMES: () => Generator<string> = function* () {};

export let TRADE_TAG_TO_REF = new Map<string, string>();

export let STAT_BY_MATCH_STR: (
  name: string,
) => { matcher: StatMatcher; stat: Stat } | undefined = () => undefined;
export let STAT_BY_REF: (name: string) => Stat | undefined = () => undefined;
export let STATS_ITERATOR: (
  includes: string,
  andIncludes?: string[],
) => Generator<Stat> = function* () {};

export let TRADE_ITEM_BY_REF: (
  itemQuery: {
    baseType?: string;
    name?: string;
    rarity?: ItemRarity;
    category?: ItemCategory;
  },
  forceCraftable?: boolean,
) => BaseType[] | undefined = () => undefined;

export let TRADE_STAT_BY_STAT_ID: (tradeId: string) => boolean = () => false;
export let TRADE_STAT_BY_MATCH_STR: (
  name: string,
) => { [type: string]: string[] } | undefined = () => undefined;

function ndjsonFindLines<T>(ndjson: string) {
  // it's preferable that passed `searchString` has good entropy
  return function* (
    searchString: string,
    andIncludes: string[] = [],
  ): Generator<T> {
    let start = 0;
    while (start !== ndjson.length) {
      const matchPos = ndjson.indexOf(searchString, start);
      if (matchPos === -1) break;
      // works for first line too (-1 + 1 = 0)
      start = ndjson.lastIndexOf("\n", matchPos) + 1;
      const end = ndjson.indexOf("\n", matchPos);
      const jsonLine = ndjson.slice(start, end);
      if (andIncludes.every((str) => jsonLine.includes(str))) {
        yield JSON.parse(jsonLine) as T;
      }
      start = end + 1;
    }
  };
}

function itemNamesFromLines(items: Generator<BaseType>) {
  let cached = "";
  return function* (): Generator<string> {
    if (!cached.length) {
      for (const item of items) {
        cached += item.name + "\n";
      }
    }

    let start = 0;
    while (start !== cached.length) {
      const end = cached.indexOf("\n", start);
      yield cached.slice(start, end);
      start = end + 1;
    }
  };
}

// POEvaluator: Map-based replacement for EE2's fnv1a binary index files.
// Keeps EE2 lookup semantics: lines are JSON.parse'd on every lookup (callers get
// fresh objects), and for ITEM_BY_* consecutive variants are returned only while
// the records are `disc` or `unique`.
function indexLines(
  ndjson: string,
  keysOf: (record: never) => string[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let start = 0;
  while (start < ndjson.length) {
    let end = ndjson.indexOf("\n", start);
    if (end === -1) end = ndjson.length;
    const line = ndjson.slice(start, end);
    if (line.trim().length) {
      for (const key of keysOf(JSON.parse(line) as never)) {
        const lines = index.get(key);
        if (lines) {
          if (!lines.includes(line)) lines.push(line);
        } else {
          index.set(key, [line]);
        }
      }
    }
    start = end + 1;
  }
  return index;
}

function loadItems(ndjson: string) {
  function commonFind(index: Map<string, string[]>) {
    return function (
      ns: BaseType["namespace"],
      name: string,
    ): BaseType[] | undefined {
      const lines = index.get(`${ns}::${name}`);
      if (!lines) return undefined;
      const out: BaseType[] = [];
      for (const line of lines) {
        const record = JSON.parse(line) as BaseType;
        out.push(record);
        if (!record.disc && !record.unique) break;
      }
      return out;
    };
  }

  ITEM_BY_TRANSLATED = commonFind(
    indexLines(ndjson, (r: BaseType) => [`${r.namespace}::${r.name}`]),
  );
  ITEM_BY_REF = commonFind(
    indexLines(ndjson, (r: BaseType) => [`${r.namespace}::${r.refName}`]),
  );
  ITEMS_ITERATOR = ndjsonFindLines<BaseType>(ndjson);
  GEM_NS_NAMES = itemNamesFromLines(ITEMS_ITERATOR('": "GEM"'));
  UNIQUE_NS_NAMES = itemNamesFromLines(ITEMS_ITERATOR('": "UNIQUE"'));
  ITEM_NS_NAMES = itemNamesFromLines(ITEMS_ITERATOR('": "ITEM"'));

  TRADE_TAG_TO_REF = new Map<string, string>();
  for (const item of ITEMS_ITERATOR('"tradeTag":')) {
    TRADE_TAG_TO_REF.set(item.tradeTag!, item.refName);
  }
}

function loadStats(ndjson: string) {
  const indexRef = indexLines(ndjson, (s: Stat) => [s.ref]);
  const indexMatcher = indexLines(ndjson, (s: Stat) =>
    s.matchers.flatMap((m) => (m.advanced ? [m.string, m.advanced] : [m.string])),
  );

  STAT_BY_REF = function (ref: string) {
    const line = indexRef.get(ref)?.[0];
    if (line === undefined) return undefined;
    return JSON.parse(line);
  };

  STAT_BY_MATCH_STR = function (matchStr: string) {
    const line = indexMatcher.get(matchStr)?.[0];
    if (line === undefined) return undefined;
    const stat = JSON.parse(line) as Stat;

    const matcher = stat.matchers.find(
      (m) => m.string === matchStr || m.advanced === matchStr,
    );
    if (!matcher) {
      return undefined;
    }
    return { stat, matcher };
  };

  STATS_ITERATOR = ndjsonFindLines<Stat>(ndjson);
}

// assertion, to avoid regressions in stats.ndjson
const DELAYED_STAT_VALIDATION = new Set<string>();
export function stat(text: string) {
  DELAYED_STAT_VALIDATION.add(text);
  return text;
}

// POEvaluator: takes the ndjson contents instead of a language code
export function init(data: { itemsNdjson: string; statsNdjson: string }) {
  CLIENT_STRINGS_REF = CLIENT_STRINGS_EN;
  CLIENT_STRINGS = CLIENT_STRINGS_EN;
  loadItems(data.itemsNdjson);
  loadStats(data.statsNdjson);
  loadUltraLateItems();

  let failed = false;
  const missing: string[] = [];

  for (const text of DELAYED_STAT_VALIDATION) {
    if (STAT_BY_REF(text) == null) {
      missing.push(text);
      failed = true;
    }
  }
  if (failed) {
    console.log(
      "Cannot find stat" + (missing.length > 1 ? "s" : "") + missing.join("\n"),
    );
  }
  DELAYED_STAT_VALIDATION.clear();
}

export function loadUltraLateItems() {
  // Augments
  const a = Array.from(ITEMS_ITERATOR('"craftable": {"category": "SoulCore"}'));
  const b = a.filter((r) => r.augment && r.augment.some((s) => s.tradeId));
  const augmentList = b.map((r) => ({
    ...r,
    augment: r.augment!.filter((s) => s.tradeId),
  }));

  AUGMENT_DATA_BY_AUGMENT = augmentsToLookup(augmentList);

  AUGMENT_DATA_BY_TRADE_ID = augmentsToLookupTradeId(augmentList);

  GROUPED_AUGMENTS = groupAugments(augmentList);

  // Catalysts
  const normalCatalysts = Array.from(ITEMS_ITERATOR('"tags": ["catalyst"'));
  const refinedCatalysts = Array.from(
    ITEMS_ITERATOR('"tags": ["jewel_catalyst"'),
  );

  CATALYST_TYPES = {
    Normal: normalCatalysts,
    Refined: refinedCatalysts,
  };

  CATALYST_TO_TAG = {
    life_catalyst: [CLIENT_STRINGS.LIFE_TAG],
    mana_catalyst: [CLIENT_STRINGS.MANA_TAG],
    defences_catalyst: [
      CLIENT_STRINGS.ARMOUR_TAG,
      CLIENT_STRINGS.EVASION_TAG,
      CLIENT_STRINGS.ENERGY_SHIELD_TAG,
    ],
    physical_catalyst: [CLIENT_STRINGS.PHYSICAL_TAG],
    fire_catalyst: [CLIENT_STRINGS.FIRE_TAG],
    cold_catalyst: [CLIENT_STRINGS.COLD_TAG],
    lightning_catalyst: [CLIENT_STRINGS.LIGHTNING_TAG],
    chaos_catalyst: [CLIENT_STRINGS.CHAOS_TAG],
    attack_catalyst: [CLIENT_STRINGS.ATTACK_TAG],
    caster_catalyst: [CLIENT_STRINGS.CASTER_TAG],
    speed_catalyst: [CLIENT_STRINGS.SPEED_TAG],
    attribute_catalyst: [CLIENT_STRINGS.ATTRIBUTE_TAG],
    minion_catalyst: [CLIENT_STRINGS.MINION_TAG],
  };
  TAG_TO_CATALYST = {
    [CLIENT_STRINGS.LIFE_TAG]: "life_catalyst",
    [CLIENT_STRINGS.MANA_TAG]: "mana_catalyst",
    [CLIENT_STRINGS.ARMOUR_TAG]: "defences_catalyst",
    [CLIENT_STRINGS.EVASION_TAG]: "defences_catalyst",
    [CLIENT_STRINGS.ENERGY_SHIELD_TAG]: "defences_catalyst",
    [CLIENT_STRINGS.PHYSICAL_TAG]: "physical_catalyst",
    [CLIENT_STRINGS.FIRE_TAG]: "fire_catalyst",
    [CLIENT_STRINGS.COLD_TAG]: "cold_catalyst",
    [CLIENT_STRINGS.LIGHTNING_TAG]: "lightning_catalyst",
    [CLIENT_STRINGS.CHAOS_TAG]: "chaos_catalyst",
    [CLIENT_STRINGS.ATTACK_TAG]: "attack_catalyst",
    [CLIENT_STRINGS.CASTER_TAG]: "caster_catalyst",
    [CLIENT_STRINGS.SPEED_TAG]: "speed_catalyst",
    [CLIENT_STRINGS.ATTRIBUTE_TAG]: "attribute_catalyst",
    [CLIENT_STRINGS.MINION_TAG]: "minion_catalyst",
  };
}

function augmentsToLookup(augmentList: BaseType[]): AugmentDataByAugment {
  const augmentDataByAugment: AugmentDataByAugment = {};

  for (const augment of augmentList) {
    if (!augment.augment) continue;
    for (const augmentStat of augment.augment) {
      const { categories, string: text, values, tradeId } = augmentStat;
      if (!tradeId) continue;
      if (!augmentDataByAugment[augment.refName]) {
        augmentDataByAugment[augment.refName] = [];
      }
      augmentDataByAugment[augment.refName]!.push({
        augment: augment.name,
        refName: augment.refName,
        baseStat: text,
        values,
        id: tradeId[0],
        categories,
        icon: augment.icon,
      });
    }
  }

  return augmentDataByAugment;
}

function augmentsToLookupTradeId(
  augmentList: BaseType[],
): AugmentDataByTradeId {
  const augmentDataByAugment: AugmentDataByTradeId = {};

  for (const augment of augmentList) {
    if (!augment.augment) continue;
    for (const augmentStat of augment.augment) {
      const { categories, string: text, values, tradeId } = augmentStat;
      if (!tradeId) continue;
      if (!augmentDataByAugment[tradeId[0]]) {
        augmentDataByAugment[tradeId[0]] = [];
      }
      augmentDataByAugment[tradeId[0]]!.push({
        refName: augment.refName,
        augment: augment.name,
        baseStat: text,
        values,
        id: tradeId[0],
        categories,
        icon: augment.icon,
      });
    }
  }

  return augmentDataByAugment;
}

function groupAugments(augmentList: BaseType[]): AugmentGroup<BaseType> {
  const grouped: AugmentGroup<BaseType> = {
    Rune: {
      Lesser: [],
      Normal: [],
      Greater: [],
      Perfect: [],
      Other: [],
    },
    Legacy: [],
    SoulCore: {
      Normal: [],
      Special: [],
    },
    Idol: [],
    Other: [],
  };

  const normalRunes = new Set(
    augmentList
      .map((a) => a.refName)
      .filter((ref) => {
        if (!ref.includes("Rune")) return false;
        if (
          ref.startsWith("Greater") ||
          ref.startsWith("Perfect") ||
          ref.startsWith("Lesser")
        ) {
          return false;
        }
        const split = ref.split(" ");
        return split.length === 2 && split[1] === "Rune";
      }),
  );

  for (const augment of augmentList) {
    const ref = augment.refName;
    if (ref.includes("Rune")) {
      const split = ref.split(" ");
      const notFirst = split.slice(1).join(" ");
      if (normalRunes.has(notFirst) || normalRunes.has(ref)) {
        if (ref.startsWith("Greater")) {
          grouped.Rune.Greater.push(augment);
        } else if (ref.startsWith("Perfect")) {
          grouped.Rune.Perfect.push(augment);
        } else if (ref.startsWith("Lesser")) {
          grouped.Rune.Lesser.push(augment);
        } else {
          grouped.Rune.Normal.push(augment);
        }
      } else {
        grouped.Rune.Other.push(augment);
      }
    } else if (ref.startsWith("Legacy")) {
      grouped.Legacy.push(augment);
    } else if (ref.includes("Soul Core")) {
      if (ref.startsWith("Soul Core")) {
        grouped.SoulCore.Normal.push(augment);
      } else {
        grouped.SoulCore.Special.push(augment);
      }
    } else if (ref.includes("Thesis")) {
      grouped.SoulCore.Special.push(augment);
    } else if (ref.includes("Idol")) {
      grouped.Idol.push(augment);
    } else {
      grouped.Other.push(augment);
    }
  }

  return grouped;
}

// Disable since this is export for tests
// eslint-disable-next-line @typescript-eslint/naming-convention
export const __testExports = {
  augmentsToLookup,
};
