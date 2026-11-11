# POEvaluator

Desktop tool for Path of Exile 2 that estimates the value of rare items based on similar listings on the official trade site.

Unlike classic price checkers, it does not just speed up the search: it considers every affix (including the ones that lower the value), gives a quick verdict (*Pessimo / Buono / Ottimo / VENDI SUBITO*) and, on demand, an in-depth analysis with a suggested price range.

**Status:** design phase. See [`docs/superpowers/specs/2026-11-11-poe2-rare-valuation-design.md`](docs/superpowers/specs/2026-11-11-poe2-rare-valuation-design.md) (in Italian).

Stack: Electron + TypeScript, Windows.

This tool does not read game memory or send automated input beyond the standard item copy (Ctrl+C) used by all accepted price checkers.
