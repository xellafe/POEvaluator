# Third-party notices

## Exiled Exchange 2

- Repository: https://github.com/Kvan7/Exiled-Exchange-2
- Commit: `cca30662bf31eaf38bd711e2ec1a6b899a06c40e` (branch `master`, 2026-09-06, latest commit available on 2026-11-12)
- License: MIT (full text below)

Copied into POEvaluator:

| POEvaluator path                                                                                                | Upstream path                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/parser/vendor/parser/*.ts`                                                                            | `renderer/src/parser/*.ts` (Parser, ParsedItem, advanced-mod-desc, augment-builder, calc-q20, magic-name, meta, modifiers, stat-translations, utils) |
| `src/core/parser/vendor/data/index.ts`, `interfaces.ts`                                                         | `renderer/src/assets/data/index.ts`, `interfaces.ts`                                                                                                 |
| `src/core/parser/vendor/data/client-strings.en.ts`                                                              | `renderer/public/data/en/client_strings.js` (typed TS copy)                                                                                          |
| `data/en/stats.ndjson`, `data/en/items.ndjson`                                                                  | `renderer/public/data/en/stats.ndjson`, `items.ndjson` (unchanged)                                                                                   |
| `data/en/client_strings.js`                                                                                     | `renderer/public/data/en/client_strings.js` (header comment added)                                                                                   |
| `TRADE_CATEGORY` table in `src/core/parser/parse-item.ts`                                                       | category table in `renderer/src/web/price-check/trade/pathofexile-trade.ts` (subset)                                                                 |
| `tests/fixtures/items/{unique,gem,unidentified,rare-waystone,rare-bow-augments}.txt`, `rare-ring-corrupted.txt` | item texts from `renderer/specs/Parser/items.ts` (the ring has a `Corrupted` section added)                                                          |

Every copied source file starts with a header naming its origin; changes are listed in the
header and marked with `POEvaluator:` comments.

```
MIT License

Copyright (c) 2020 Alexander Drozdov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Inter (font)

- Package: `@fontsource-variable/inter` (font files bundled into the renderer build)
- Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
- License: SIL Open Font License 1.1 — full text in
  `node_modules/@fontsource-variable/inter/LICENSE` and at https://openfontlicense.org

## RePoE (repoe-fork)

- Repository: https://github.com/repoe-fork/repoe, data published at https://repoe-fork.github.io/poe2/
- License: MIT (Copyright (c) 2016 brather1ng). The generated data files are owned by Grinding Gear Games and are used in accordance with their terms of use.

`data/mod-tiers.json` is derived from `mods.min.json` and `base_items.min.json` (downloaded on 2026-11-14) by `scripts/build-mod-tiers.mjs`: it keeps only mod families, spawn weights and base tags, used to show how many tiers an affix has on a base.
