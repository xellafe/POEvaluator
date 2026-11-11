# POEvaluator M1 — Valutazione del singolo oggetto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App Electron che, con una hotkey su un oggetto raro di PoE2, mostra un verdetto rapido (Pessimo/Buono/Ottimo/VENDI SUBITO) e, su richiesta, un'analisi approfondita con prezzo consigliato, fascia, confidenza e contributo dei singoli affissi.

**Architecture:** Il core (`src/core/`) è TypeScript puro, senza dipendenze Electron, testato con Vitest in Node: parser, client trade con rate limiter e coda a priorità, database locale `node:sqlite`, motore di valutazione (rapido kNN + approfondito a ricerche multiple), raccolta in background. Il main process Electron (`src/main/`) collega hotkey, appunti, finestre overlay e IPC. Il renderer (`src/renderer/`, React) disegna badge, pannello oggetto e impostazioni.

**Tech Stack:** Electron 40, TypeScript 5.9, electron-vite, React 19, Vitest, `node:sqlite` (Node 24 incluso in Electron 40), `uiohook-napi` (hotkey e invio Ctrl+Alt+C), `electron-overlay-window` (aggancio alla finestra di gioco). Parser e dati affissi riusati da Exiled Exchange 2 (MIT).

**Spec:** `docs/superpowers/specs/2026-11-11-poe2-rare-valuation-design.md`

## Global Constraints

- Solo Windows; PoE2 in finestra o borderless.
- Nessuna lettura della memoria del gioco, nessun input al gioco oltre al singolo Ctrl+Alt+C per pressione di hotkey.
- Tutte le chiamate al trade passano dalla coda unica (`TradeClient`) e rispettano gli header `X-Rate-Limit-*` e `Retry-After`. Priorità: `user` > `stash` > `background`.
- User-Agent di tutte le richieste HTTP: `POEvaluator/<version> (+https://github.com/xellafe/POEvaluator)`.
- Codice riusato da Exiled Exchange 2 (https://github.com/Kvan7/Exiled-Exchange-2, MIT): mantenere il copyright in `THIRD_PARTY_NOTICES.md` e in testa ai file copiati. Licenza di POEvaluator: MIT.
- Prezzi interni sempre in **Exalted Orb** (`priceExalted`); la UI mostra anche l'equivalente in Divine.
- Ogni stima riporta fascia e confidenza (`alta`/`media`/`bassa`); mai un prezzo senza confidenza.
- Solo oggetti rari identificati in M1. Gli altri restituiscono un errore esplicito ("tipo di oggetto non ancora supportato").
- Overlay: click-through, nessun furto di focus, visibile solo con PoE2 in primo piano.
- Testi UI in italiano.

## Review Focus

1. **Testo negli appunti non valido** (appunti vuoti, testo non PoE, oggetto non identificato, unico, gemma): messaggio chiaro, nessun crash, nessuna chiamata al trade. → test in Task 2.
2. **429 o restrizione attiva sul trade**: la coda si ferma per il tempo indicato e riprende senza perdere richieste; la raccolta in background non riparte durante la restrizione. → test in Task 3 e Task 4.
3. **Pochi comparabili o nessuno**: niente prezzo inventato; verdetto con confidenza `bassa` e avviso. → test in Task 7.
4. **Valuta del prezzo sconosciuta o tassi non disponibili** (prima del primo download dei tassi): l'inserzione si scarta, non si converte con tasso 1. → test in Task 5.
5. **Cambio di league**: comparabili e raccolta filtrati per la league configurata; i dati di altre league non entrano nella stima. → test in Task 6.

---

## Struttura dei file

```
src/
  core/
    types.ts                      # tipi condivisi (Task 2)
    parser/                       # vendored EE2 + adapter (Task 2)
      vendor/…                    # file EE2 copiati
      parse-item.ts
    trade/
      rate-limiter.ts             # Task 3
      trade-client.ts             # Task 4
      listing-mapper.ts           # Task 4
      query-builder.ts            # Task 4
    pricing/
      currency.ts                 # Task 5
    db/
      listing-store.ts            # Task 6
    valuation/
      price-strategy.ts           # Task 7
      deep-analysis.ts            # Task 9
      features.ts                 # Task 8
      quick-evaluator.ts          # Task 8
      default-weights.json        # Task 8
    collector/
      background-collector.ts     # Task 10
    settings.ts                   # Task 1
  main/
    index.ts                      # Task 1, 11
    capture.ts                    # Task 11
    evaluator-service.ts          # Task 11
    overlay.ts                    # Task 13
  preload/index.ts                # Task 11
  renderer/                       # Task 13
tests/                            # specchia src/core
data/en/stats.ndjson, items.ndjson   # dati EE2 (Task 2)
```

---

### Task 1: Scaffolding del progetto

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/core/settings.ts`, `LICENSE` (MIT), `.gitignore`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/core/settings.ts
  export interface Settings {
    league: string;                 // default "Standard"
    hotkeys: { quick: string; deep: string };   // default "Alt+D", "Alt+Shift+D"
    thresholds: { buono: number; ottimo: number; vendiSubito: number }; // in exalted: 5, 50, 300
    backgroundCollection: boolean;  // default true
    maxListingAgeDays: number;      // default 7
  }
  export const DEFAULT_SETTINGS: Settings;
  export function mergeSettings(saved: unknown): Settings; // valori mancanti/invalidi -> default
  ```

- [ ] **Step 1:** Scaffold con `npm create @quick-start/electron@latest . -- --template react-ts`, poi aggiungi `vitest` come devDependency e lo script `"test": "vitest run"`. Imposta `"engines": { "node": ">=24" }`.
- [ ] **Step 2: test** `tests/settings.test.ts`:
  - `mergeSettings(undefined)` è uguale a `DEFAULT_SETTINGS`;
  - `mergeSettings({ league: "Dawn", thresholds: { buono: "x" } })` → `league === "Dawn"`, `thresholds.buono === 5`, gli altri campi di default.
- [ ] **Step 3:** `npm test` → FAIL.
- [ ] **Step 4:** Implementa `src/core/settings.ts`.
- [ ] **Step 5:** `npm test` → PASS; `npm run dev` apre una finestra vuota senza errori in console.
- [ ] **Step 6:** Commit `chore: scaffolding electron-vite + vitest`.

---

### Task 2: Parser degli oggetti (riuso EE2)

**Files:**
- Create: `src/core/types.ts`, `src/core/parser/vendor/*` (copiati da EE2 `renderer/src/parser/*` e `renderer/src/assets/data/*`), `data/en/stats.ndjson`, `data/en/items.ndjson`, `data/en/client_strings.js`, `src/core/parser/parse-item.ts`, `THIRD_PARTY_NOTICES.md`
- Test: `tests/parser/parse-item.test.ts`, `tests/fixtures/items/*.txt`

**Interfaces:**
- Produces:
  ```ts
  // src/core/types.ts
  export type ModType = 'prefix' | 'suffix' | 'implicit' | 'rune' | 'enchant';
  export interface ItemMod {
    statId: string;            // id stat del trade, es. "explicit.stat_3299347043"
    text: string;              // riga come in gioco
    values: number[];
    type: ModType;
    tier?: number;
    range?: { min: number; max: number };   // range del tier, dal testo avanzato
  }
  export interface RareItem {
    raw: string;
    itemClass: string;         // categoria trade, es. "armour.boots"
    baseType: string;
    name: string;
    itemLevel: number;
    quality: number;
    corrupted: boolean;
    explicits: ItemMod[];      // prefix + suffix
    implicits: ItemMod[];      // implicit, rune, enchant
    openPrefixes: number;      // 3 - prefix presenti
    openSuffixes: number;
  }
  export type ParseResult =
    | { ok: true; item: RareItem }
    | { ok: false; reason: 'empty' | 'not_poe_item' | 'unidentified' | 'unsupported_rarity' };
  export type Verdict = 'pessimo' | 'buono' | 'ottimo' | 'vendi_subito';
  export type Confidence = 'alta' | 'media' | 'bassa';
  export interface Listing {
    id: string; league: string; itemClass: string; baseType: string; itemLevel: number;
    mods: { statId: string; value: number }[];
    openPrefixes: number; openSuffixes: number;
    priceAmount: number; priceCurrency: string; priceExalted: number;
    indexedAt: string;  // ISO
    seenAt: string;     // ISO
  }
  export interface Valuation {
    verdict: Verdict;
    confidence: Confidence;
    price?: { suggested: number; min: number; max: number };   // exalted
    contributions?: { statId: string; text: string; deltaExalted: number }[];
    comparablesCount: number;
    tradeUrl?: string;
    warnings: string[];
  }
  // src/core/parser/parse-item.ts
  export function parseItemText(text: string): ParseResult;
  ```

- [ ] **Step 1:** Copia parser e dati da EE2 (commit di master del 2026-11-10 o successivo; annota lo SHA in `THIRD_PARTY_NOTICES.md` insieme al testo della licenza MIT). Rimuovi le dipendenze Vue/renderer sostituendole con import locali. Il caricamento dei dati legge `data/en/*.ndjson` dal disco (path passato all'init: `initParserData(dataDir: string): Promise<void>`).
- [ ] **Step 2: fixture.** In `tests/fixtures/items/` metti testi reali in formato avanzato (Ctrl+Alt+C): `rare-boots.txt` (3 prefix, 2 suffix), `rare-ring-corrupted.txt`, `unidentified.txt`, `unique.txt`, `gem.txt`. Se EE2 ha fixture PoE2 nei test, partire da quelle.
- [ ] **Step 3: test** `parse-item.test.ts`:
  - `rare-boots.txt` → `ok`, `itemClass === "armour.boots"`, `explicits.filter(m => m.type==='prefix').length === 3`, `openPrefixes === 0`, `openSuffixes === 1`, ogni mod ha `statId` che inizia per `explicit.`;
  - `rare-ring-corrupted.txt` → `corrupted === true`;
  - `""` → `{ ok:false, reason:'empty' }`; `"ciao"` → `not_poe_item`; `unidentified.txt` → `unidentified`; `unique.txt` e `gem.txt` → `unsupported_rarity`.
- [ ] **Step 4:** `npm test -- parse-item` → FAIL.
- [ ] **Step 5:** Implementa `parseItemText` come adapter da `ParsedItem` di EE2 a `RareItem`.
- [ ] **Step 6:** `npm test -- parse-item` → PASS.
- [ ] **Step 7:** Commit `feat(core): parser oggetti rari basato su Exiled Exchange 2`.

---

### Task 3: Rate limiter

**Files:**
- Create: `src/core/trade/rate-limiter.ts`
- Test: `tests/trade/rate-limiter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateLimitRule { maxHits: number; periodSec: number; restrictSec: number }
  export interface RateLimitState { hits: number; periodSec: number; activeRestrictionSec: number }
  export function parseRateLimitHeaders(h: Headers): { rules: RateLimitRule[]; state: RateLimitState[] };
  export class RateLimiter {
    constructor(now?: () => number);
    update(h: Headers): void;                 // legge X-Rate-Limit-Rules, X-Rate-Limit-<Rule>, X-Rate-Limit-<Rule>-State, Retry-After
    recordRequest(): void;
    delayMs(): number;                        // 0 se si può chiamare subito
    remainingRatio(): number;                 // 0..1, minimo tra le regole
  }
  ```
  Formato header: `X-Rate-Limit-Rules: Ip,Account`; `X-Rate-Limit-Ip: 8:10:60,15:60:120` (hits:periodo:restrizione); `X-Rate-Limit-Ip-State: 1:10:0,1:60:0`.

- [ ] **Step 1: test**:
  - `parseRateLimitHeaders` sull'esempio sopra → 2 regole `{8,10,60}`, `{15,60,120}` e stati `{1,10,0}`, `{1,60,0}`;
  - dopo 8 `recordRequest()` in 1 s con regola `8:10:60`, `delayMs() > 0` e `<= 10000`;
  - con stato `...:60:45` (restrizione attiva) → `delayMs() === 45000`;
  - con `Retry-After: 30` → `delayMs() === 30000`;
  - `remainingRatio()` con 4 hit su `8:10` → `0.5`.
  - Margine di sicurezza: il limiter considera `maxHits - 1` come tetto.
- [ ] **Step 2:** run → FAIL. **Step 3:** implementa (finestra scorrevole di timestamp per regola). **Step 4:** run → PASS.
- [ ] **Step 5:** Commit `feat(trade): rate limiter basato sugli header GGG`.

---

### Task 4: Client trade, query builder e mapping delle inserzioni

**Files:**
- Create: `src/core/trade/trade-client.ts`, `src/core/trade/query-builder.ts`, `src/core/trade/listing-mapper.ts`
- Test: `tests/trade/trade-client.test.ts`, `tests/trade/query-builder.test.ts`, `tests/trade/listing-mapper.test.ts`, `tests/fixtures/trade/fetch-response.json`

**Interfaces:**
- Consumes: `RateLimiter` (Task 3), `RareItem`, `Listing` (Task 2), `CurrencyRates` (Task 5: il mapper riceve una funzione `toExalted`, quindi non dipende dall'implementazione).
- Produces:
  ```ts
  export type Priority = 'user' | 'stash' | 'background';
  export interface SearchResult { id: string; result: string[]; total: number }
  export class TradeClient {
    constructor(opts: { userAgent: string; fetchImpl?: typeof fetch; limiter?: RateLimiter });
    search(league: string, query: object, priority: Priority): Promise<SearchResult>;
    // POST https://www.pathofexile.com/api/trade2/search/poe2/{encodeURIComponent(league)}
    fetchListings(ids: string[], queryId: string, priority: Priority): Promise<unknown[]>;
    // GET  https://www.pathofexile.com/api/trade2/fetch/{ids.join(',')}?query={queryId}, a blocchi di 10
    isIdle(): boolean;          // nessuna richiesta user/stash in coda
    remainingRatio(): number;
  }
  export function tradeUrl(league: string, queryId: string): string;
  // query-builder.ts
  export interface QueryOptions { mods: ItemMod[]; valueFactor: number; minOpenPrefixes?: number; minOpenSuffixes?: number }
  export function buildQuery(item: RareItem, opts: QueryOptions): object;
  // listing-mapper.ts
  export function toListing(raw: unknown, league: string, toExalted: (amount: number, currency: string) => number | null, now: Date): Listing | null;
  ```

- [ ] **Step 1: test coda** (con `fetchImpl` finto):
  - una richiesta `background` accodata prima di una `user` parte **dopo** la `user` se entrambe sono in attesa;
  - risposta 429 con `Retry-After: 2`: la richiesta viene ripetuta dopo ≥ 2000 ms (usa fake timers), nessuna eccezione verso il chiamante;
  - `fetchListings` con 23 id → 3 chiamate GET;
  - ogni richiesta ha header `User-Agent` uguale a quello passato.
- [ ] **Step 2: test query-builder**:
  - `buildQuery(boots, { mods: [modVita], valueFactor: 0.8 })` produce `query.filters.type_filters.filters.category.option === "armour.boots"`, `query.status.option === "online"`, un gruppo `stats` di tipo `"and"` con `{ id: modVita.statId, value: { min: Math.floor(vita*0.8) } }`, `sort: { price: "asc" }`;
  - con `minOpenPrefixes: 1` aggiunge il filtro pseudo sugli slot prefix liberi (lo stat id esatto va preso da `stats.ndjson`: cerca "Empty Prefix" e annotalo in una costante).
- [ ] **Step 3: test listing-mapper** su `fetch-response.json` (registrato a mano con una ricerca reale):
  - mappa `listing.price.amount/currency`, `item.extended.mods`/`hashes` in `mods`, `listing.indexed` in `indexedAt`;
  - `toExalted` che restituisce `null` → `toListing` restituisce `null` (Review Focus 4).
- [ ] **Step 4:** run → FAIL. **Step 5:** implementa i tre file. **Step 6:** run → PASS.
- [ ] **Step 7:** Commit `feat(trade): client trade2 con coda a priorità e query builder`.

---

### Task 5: Normalizzazione delle valute

**Files:**
- Create: `src/core/pricing/currency.ts`
- Test: `tests/pricing/currency.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CurrencyRates { league: string; fetchedAt: string; exaltedPer: Record<string, number> } // "divine" -> 250, "exalted" -> 1, "chaos" -> ...
  export function makeConverter(rates: CurrencyRates | null): (amount: number, currency: string) => number | null;
  export async function fetchRates(league: string, fetchImpl: typeof fetch, userAgent: string): Promise<CurrencyRates>;
  ```
- [ ] **Step 0 (verifica):** individua l'endpoint poe.ninja per PoE2 che restituisce i tassi delle currency rispetto all'Exalted (aprendo poe.ninja/poe2/economy e leggendo le chiamate di rete). Salva una risposta reale in `tests/fixtures/ninja-rates.json` e scrivi l'URL in una costante. Se poe.ninja non è utilizzabile, usa l'endpoint exchange del trade (`/api/trade2/exchange/poe2/{league}`) passando dal `TradeClient` con priorità `background`.
- [ ] **Step 1: test**: `makeConverter(rates)(2, "divine") === 500` con `divine: 250`; `"exalted"` → identità; valuta assente → `null`; `makeConverter(null)` → sempre `null`; `fetchRates` sulla fixture produce `exaltedPer.divine > 1`.
- [ ] **Step 2–4:** FAIL → implementa → PASS. Aggiornamento dei tassi ogni 30 minuti (gestito nel servizio, Task 11).
- [ ] **Step 5:** Commit `feat(pricing): conversione prezzi in exalted`.

---

### Task 6: Database locale delle inserzioni

**Files:**
- Create: `src/core/db/listing-store.ts`
- Test: `tests/db/listing-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ListingStore {
    constructor(path: string);               // ":memory:" nei test; usa node:sqlite DatabaseSync
    upsert(listings: Listing[]): void;       // chiave: id; aggiorna seenAt/prezzo
    comparables(f: { league: string; itemClass: string; maxAgeDays: number; now: Date }): Listing[];
    countByClass(league: string): Record<string, number>;
    saveRates(r: CurrencyRates): void; latestRates(league: string): CurrencyRates | null;
  }
  ```
  Tabelle: `listings` (colonne di `Listing`, `mods` come JSON) con indice `(league, itemClass, indexedAt)`; `rates`.

- [ ] **Step 1: test**:
  - `upsert` due volte dello stesso id con prezzo diverso → 1 riga, prezzo aggiornato;
  - `comparables` esclude le inserzioni di un'altra league (Review Focus 5) e quelle con `indexedAt` più vecchio di `maxAgeDays`;
  - `countByClass` conta per classe.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** Commit `feat(db): archivio locale delle inserzioni su node:sqlite`.

---

### Task 7: Strategia di prezzo e verdetto

**Files:**
- Create: `src/core/valuation/price-strategy.ts`
- Test: `tests/valuation/price-strategy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function cleanPrices(pricesExalted: number[]): number[];   // rimuove outlier con Tukey 1.5×IQR (solo se n ≥ 4)
  export function confidenceFor(prices: number[]): Confidence;
  // alta: n ≥ 10 e IQR/mediana ≤ 0.5; media: n ≥ 4; bassa: altrimenti
  export function verdictFor(estimateExalted: number, t: Settings['thresholds']): Verdict;
  // < buono -> pessimo; < ottimo -> buono; < vendiSubito -> ottimo; altrimenti vendi_subito
  export function priceFor(prices: number[], t: Settings['thresholds']): Pick<Valuation, 'verdict'|'confidence'|'price'|'comparablesCount'|'warnings'>;
  ```
  Algoritmo di `priceFor` (dalla tabella §2.4 dello spec):
  1. `clean = cleanPrices(prices)`; se `clean.length < 2` → `verdict = clean.length === 1 ? verdictFor(clean[0], t) : 'pessimo'`, `confidence: 'bassa'`, nessun `price`, warning `"Troppo pochi oggetti simili sul mercato"`.
  2. Stima = mediana di `clean` → `verdictFor`.
  3. `suggested` = percentile 20 se `buono`, 60 se `ottimo`, 75 se `vendi_subito`; nessun prezzo se `pessimo`.
  4. `min` = percentile 10, `max` = percentile 90.
  5. `vendi_subito` aggiunge sempre il warning `"Oggetto eccezionale: verifica il prezzo a mano"`.

- [ ] **Step 1: test** con array noti: percentili e verdetti esatti per `[10,12,14,15,16,18,20,22,25,1000]` (1000 rimosso da Tukey), soglie di default; array vuoto → nessun prezzo, `bassa`, warning (Review Focus 3); stima 400 → `vendi_subito` + warning.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** Commit `feat(valuation): strategia di prezzo per fascia`.

---

### Task 8: Valutatore rapido

**Files:**
- Create: `src/core/valuation/features.ts`, `src/core/valuation/quick-evaluator.ts`, `src/core/valuation/default-weights.json`
- Test: `tests/valuation/quick-evaluator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // default-weights.json: { [itemClass: string]: { [statId: string]: number /* 0..1 */ } }
  // Pesi minimi scritti a mano per le classi principali (boots, gloves, helmet, body armour, belt, ring, amulet, armi, focus, quiver):
  // vita, resistenze, movement speed (boots), +livelli alle gemme, crit, spirit, danni fisici/elementali % per armi, attack/cast speed.
  export function featureVector(mods: { statId: string; value: number }[], openPrefixes: number, openSuffixes: number, itemLevel: number, scale: Record<string, number>): Record<string, number>;
  // valore normalizzato per stat = value / scale[statId] (scale = 95° percentile del valore nei listing della classe), più "open" e "ilvl"/100
  export function weightScore(item: RareItem, weights: Record<string, number>): number; // somma pesi × valore normalizzato (0..1 col max del tier)
  export function quickEvaluate(item: RareItem, store: ListingStore, settings: Settings, now: Date): Valuation;
  ```
  Logica di `quickEvaluate`:
  - Se `store.countByClass(league)[itemClass] ≥ 30`: kNN con k = 10 sui `comparables` (distanza euclidea pesata con `default-weights` + 0.1 per gli stat senza peso), prezzi dei vicini → `priceFor`. Confidenza al massimo `media`.
  - Altrimenti fallback: `weightScore` → `pessimo` (< 0.3), `buono` (< 0.6), `ottimo` (< 0.85), `vendi_subito`; nessun prezzo, `confidence: 'bassa'`, warning `"Pochi dati locali: verdetto indicativo, usa l'analisi approfondita"`.
  - Nessuna chiamata di rete.

- [ ] **Step 1: test**:
  - store vuoto, boots con vita alta + movement speed alta → fallback, verdetto ≥ `buono`, `confidence 'bassa'`, nessun `price`;
  - boots con soli mod a peso 0 → `pessimo`;
  - store con 40 listing sintetici di boots (prezzo proporzionale alla vita) → item con vita alta ha `price.suggested` maggiore di item con vita bassa; `confidence !== 'alta'`.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** Commit `feat(valuation): valutatore rapido kNN con fallback a pesi`.

---

### Task 9: Analisi approfondita

**Files:**
- Create: `src/core/valuation/deep-analysis.ts`
- Test: `tests/valuation/deep-analysis.test.ts`

**Interfaces:**
- Consumes: `TradeClient`, `buildQuery`, `toListing`, `ListingStore.upsert`, `priceFor`, `makeConverter`.
- Produces:
  ```ts
  export interface DeepDeps { client: TradeClient; store: ListingStore; toExalted: (a: number, c: string) => number | null; settings: Settings; now: () => Date; maxSearches?: number /* default 8 */ }
  export async function deepAnalysis(item: RareItem, deps: DeepDeps, onProgress?: (done: number, total: number) => void): Promise<Valuation>;
  ```
  Algoritmo:
  1. `mods` = espliciti ordinati per peso (da `default-weights.json`, Task 8; peso 0 per gli stat non presenti, a parità il tier più alto).
  2. Ricerca base: tutti i `mods` con `valueFactor 0.8`. Se `total < 5`, togli il mod di peso minore e ripeti, finché `total ≥ 5` o restano 1 mod (ogni tentativo conta nel budget).
  3. Fetch dei primi 20 risultati → `toListing` → `store.upsert` → prezzi.
  4. Contributi: per ciascuno dei mod nella query finale (fino a esaurire il budget), ricerca senza quel mod → `deltaExalted = mediana(base) - mediana(senza mod)` (mediana di 10 risultati).
  5. Penalità slot occupati: se `openPrefixes + openSuffixes === 0` e c'è budget, ricerca della query finale con `minOpenPrefixes: 1` o `minOpenSuffixes: 1`; se la mediana è più alta, aggiungi warning `"Oggetti simili con slot liberi valgono di più (~X ex)"` e usa come stima la minore delle due mediane.
  6. `priceFor` + `contributions` + `tradeUrl` della ricerca base.

- [ ] **Step 1: test** con `TradeClient` finto (risposte programmate per numero di mod nella query):
  - base con 4 mod e `total=2`, con 3 mod e `total=12` → 2 ricerche iniziali, la query finale ha 3 mod;
  - mai più di `maxSearches` chiamate a `search`;
  - le inserzioni recuperate finiscono nello store;
  - contributo positivo per il mod la cui rimozione abbassa la mediana;
  - `onProgress` chiamato con `total === maxSearches`.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** Commit `feat(valuation): analisi approfondita a ricerche multiple`.

---

### Task 10: Raccolta in background

**Files:**
- Create: `src/core/collector/background-collector.ts`
- Test: `tests/collector/background-collector.test.ts`

**Interfaces:**
- Consumes: `TradeClient` (`isIdle`, `remainingRatio`, `search`, `fetchListings` con priorità `background`), `buildQuery`, `toListing`, `ListingStore`, `default-weights.json`.
- Produces:
  ```ts
  export class BackgroundCollector {
    constructor(deps: { client: TradeClient; store: ListingStore; toExalted: (a: number, c: string) => number | null; settings: () => Settings; now: () => Date });
    tick(): Promise<'collected' | 'skipped'>;   // una ricerca + fetch di 20 risultati
    start(intervalMs?: number): void;           // default 20000
    stop(): void;
  }
  ```
  Regole: `tick` salta se `settings().backgroundCollection === false`, se `!client.isIdle()` o se `client.remainingRatio() < 0.5`. Seed: round robin su (classe, stat) di `default-weights.json` con peso ≥ 0.5, query con quel solo stat e soglia minima = 50% del massimo noto, ordinata per prezzo crescente.

- [ ] **Step 1: test**: salta con setting disattivato, con client non idle e con `remainingRatio 0.3`; con condizioni ok fa 1 search e salva le inserzioni nella league corrente; due tick consecutivi usano seed diversi.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** Commit `feat(collector): raccolta inserzioni in background`.

---

### Task 11: Main process — cattura, servizio e IPC

**Files:**
- Create: `src/main/capture.ts`, `src/main/evaluator-service.ts`; Modify: `src/main/index.ts`, `src/preload/index.ts`
- Test: `tests/main/evaluator-service.test.ts` (il servizio non importa Electron: riceve le dipendenze)

**Interfaces:**
- Produces:
  ```ts
  // evaluator-service.ts
  export type EvalResult = { ok: true; item: RareItem; valuation: Valuation } | { ok: false; message: string };
  export class EvaluatorService {
    constructor(deps: { client: TradeClient; store: ListingStore; settings: () => Settings; fetchRates: () => Promise<CurrencyRates>; now: () => Date });
    init(): Promise<void>;                       // carica i tassi dallo store, poi li aggiorna ogni 30 min
    quick(text: string): EvalResult;
    deep(text: string, onProgress: (d: number, t: number) => void): Promise<EvalResult>;
  }
  // capture.ts
  export async function copyHoveredItem(): Promise<string>; // salva appunti, uiohook keyTap Ctrl+Alt+C, attende cambio appunti (max 500 ms), ripristina appunti precedenti
  // IPC (preload espone window.poe):
  //   'valuation:result' main->renderer { kind:'quick'|'deep', ... }
  //   'valuation:progress' main->renderer { done, total }
  //   'valuation:deep' renderer->main (click "Analizza" sul badge)
  //   'settings:get' / 'settings:set'
  ```
  Messaggi di errore (`ok:false`): `empty` → "Nessun oggetto copiato: passa il mouse su un oggetto e riprova"; `not_poe_item` → "Il testo copiato non è un oggetto di PoE2"; `unidentified` → "Oggetto non identificato"; `unsupported_rarity` → "Per ora valuto solo oggetti rari".

- [ ] **Step 1: test** servizio con dipendenze finte: `quick("")` → messaggio "Nessun oggetto copiato…" e nessuna chiamata al client (Review Focus 1); `quick(rareBoots)` → `ok` senza chiamate di rete; prima del caricamento dei tassi `deep` restituisce comunque una `Valuation` (inserzioni scartate → `bassa`).
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** In `index.ts`: impostazioni persistite in `app.getPath('userData')/settings.json` via `mergeSettings`; DB in `userData/poevaluator.db`; registrazione hotkey con `uiohook-napi` (attive solo con PoE2 in primo piano); avvio del `BackgroundCollector`.
- [ ] **Step 6:** Verifica manuale: `npm run dev`, PoE2 aperto, hotkey `Alt+D` su un raro → log in console del `Valuation`.
- [ ] **Step 7:** Commit `feat(main): cattura oggetto, servizio di valutazione e IPC`.

---

### Task 12: Mockup dell'interfaccia — approvazione dell'utente (GATE)

**Files:**
- Create: `docs/design/m1-mockups.html`

- [ ] **Step 1:** Prepara mockup HTML statici di: badge del verdetto vicino al cursore (4 stati + caricamento + errore), pannello dell'analisi approfondita (prezzo in ex e div, fascia, confidenza, contributi per affisso, warning, link al trade, progresso), finestra impostazioni (league, hotkey, soglie, raccolta in background).
- [ ] **Step 2:** **Fermati** e chiedi all'utente di approvare o correggere i mockup. Non iniziare il Task 13 senza approvazione esplicita.
- [ ] **Step 3:** Commit `docs: mockup interfaccia M1 approvati`.

---

### Task 13: Overlay e renderer

**Files:**
- Create: `src/main/overlay.ts`, `src/renderer/components/VerdictBadge.tsx`, `src/renderer/components/ItemPanel.tsx`, `src/renderer/components/SettingsWindow.tsx`, `src/renderer/format.ts`
- Test: `tests/renderer/format.test.ts`

**Interfaces:**
- Consumes: IPC del Task 11; mockup approvati del Task 12.
- Produces:
  ```ts
  // format.ts
  export function formatPrice(exalted: number, exaltedPerDivine: number | null): string; // "45 ex" | "1.8 div (450 ex)" sopra 1 divine
  export function verdictLabel(v: Verdict): string;  // "Pessimo" | "Buono" | "Ottimo" | "VENDI SUBITO"
  ```
- [ ] **Step 1: test** `formatPrice(45, 250) === "45 ex"`, `formatPrice(450, 250) === "1.8 div (450 ex)"`, `formatPrice(450, null) === "450 ex"`; `verdictLabel('vendi_subito') === "VENDI SUBITO"`.
- [ ] **Step 2–4:** FAIL → implementa `format.ts` → PASS.
- [ ] **Step 5:** `overlay.ts`: finestra trasparente agganciata a PoE2 con `electron-overlay-window` (`focusable: false`, `setIgnoreMouseEvents(true, { forward: true })` tranne sopra badge/pannello), nascosta quando PoE2 non è in primo piano. Finestra impostazioni separata e normale, aperta dal tray.
- [ ] **Step 6:** Componenti React come da mockup approvati. Il badge sparisce dopo 4 s o al movimento del mouse oltre 150 px; click sul badge → `valuation:deep`.
- [ ] **Step 7: verifica manuale** in gioco: badge in < 2 s, il gioco mantiene il focus (si continua a muoversi), il pannello mostra il progresso dell'analisi, errori mostrati per oggetto unico e appunti vuoti.
- [ ] **Step 8:** Commit `feat(ui): overlay con badge, pannello oggetto e impostazioni`.

---

### Task 14: Verifica finale M1

- [ ] **Step 1:** `npm test` → tutto PASS; `npm run build` senza errori di tipo.
- [ ] **Step 2:** Sessione di gioco di 30 minuti con raccolta in background attiva: nessun 429 nei log; `countByClass` cresce.
- [ ] **Step 3:** Su 5 rari, confronta l'analisi approfondita con una ricerca manuale sul sito trade e annota le differenze in `docs/m1-verification.md`.
- [ ] **Step 4:** Aggiorna `README.md` (installazione, hotkey, avvertenze ToS) e commit `docs: verifica M1`.
