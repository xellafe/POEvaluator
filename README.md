# POEvaluator

Desktop tool for Path of Exile 2 that estimates the value of rare items based on similar listings on the official trade site.

Unlike classic price checkers, it does not just speed up the search: it weighs every affix (including the ones that lower the value), gives a quick verdict (*Pessimo / Buono / Ottimo / Eccellente*) and, on demand, an in-depth analysis with a suggested price range and the contribution of each affix.

The interface is in Italian. Design docs (in Italian) are in [`docs/superpowers/specs/`](docs/superpowers/specs/).

**Status:** milestone M1 (single rare item valuation), not yet verified in game. Windows only.

## Requirements

- Windows 10/11
- Node.js 24 or newer
- Path of Exile 2 in windowed or borderless fullscreen mode (the overlay cannot draw over exclusive fullscreen)

## Install and run

```bash
git clone https://github.com/xellafe/POEvaluator.git
cd POEvaluator
npm install
npm run dev
```

The app starts in the system tray. Open **Impostazioni** from the tray icon to set the league (default `Standard`), the hotkeys and the verdict thresholds. Settings are saved in `%APPDATA%\poevaluator\settings.json`, the listing database in `%APPDATA%\poevaluator\poevaluator.db`.

## Usage

| Hotkey (default) | Action |
|---|---|
| `Alt+D` | Quick verdict for the item under the mouse cursor, from locally collected listings (no network request) |
| `Alt+Shift+D` | In-depth analysis: up to 8 searches on the trade site, spaced out to respect its rate limits |
| `Esc` | Close the badge or the panel |

Hotkeys only work while Path of Exile 2 is the foreground window. Clicking the badge also starts the in-depth analysis.

With *background collection* enabled (default), the app slowly downloads listings for the most common item classes while you play, so the quick verdict becomes more accurate over time.

Prices are shown in exalted orbs; from 1 divine upwards they are shown in divines with the exalted value in brackets. Exchange rates come from [poe.ninja](https://poe.ninja).

## Terms of Service

POEvaluator behaves like the price checkers accepted by the community:

- it does not read or modify game memory or files;
- the only input it sends to the game is the standard *copy item* shortcut (`Ctrl+Alt+C`), triggered by your own hotkey press;
- it uses the public trade API with a descriptive User-Agent and follows the rate limits returned by the server.

Use it at your own risk; this project is not affiliated with or endorsed by Grinding Gear Games.

## Development

```bash
npm test          # Vitest
npm run typecheck
npm run build
```

Stack: Electron 44, electron-vite, React, TypeScript, `node:sqlite`. The item parser is vendored from [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) (MIT), see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
