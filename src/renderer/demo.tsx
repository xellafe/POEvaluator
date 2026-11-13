// Galleria degli stati dell'interfaccia con dati di esempio: solo in sviluppo (#demo).
/* eslint-disable react-refresh/only-export-components -- file di sola sviluppo, non usa il fast refresh */
import type { JSX } from 'react'
import type { Root } from 'react-dom/client'
import type { PoeApi } from '../core/ipc'
import { DEFAULT_SETTINGS } from '../core/settings'
import type { RareItem, Valuation } from '../core/types'
import { ItemPanel, type PanelState } from './components/ItemPanel'
import { SettingsWindow } from './components/SettingsWindow'
import { VerdictBadge, type BadgeState } from './components/VerdictBadge'

type DemoMod = RareItem['explicits'][number]

/** Affisso di esempio con id trade reale (lo stato nel pannello dipende dai pesi della classe). */
const mod = (statId: string, text: string, type: DemoMod['type'], tier?: number): DemoMod => ({
  statId: `explicit.stat_${statId}`,
  text,
  values: [],
  tradeValue: 1,
  type,
  ...(tier !== undefined ? { tier } : {})
})

const ITEM: RareItem = {
  raw: '',
  itemClass: 'armour.boots',
  baseType: 'Expert Feathered Sandals',
  name: 'Gale Stride',
  itemLevel: 82,
  quality: 0,
  corrupted: false,
  explicits: [
    mod('2250533757', '30% increased Movement Speed', 'prefix', 1),
    mod('3299347043', '+74 to maximum Life', 'prefix', 6),
    mod('1368271171', 'Gain 3 Mana per enemy killed', 'prefix', 8),
    mod('4220027924', '+38% to Cold Resistance', 'suffix', 3),
    mod('3261801346', '+12 to Dexterity', 'suffix', 7)
  ],
  implicits: [],
  openPrefixes: 0,
  openSuffixes: 0
}

const RATE = 250

/** Arma d'attacco: i danni locali sono nel DPS, gli affissi senza peso sono esclusi. */
const WEAPON: RareItem = {
  raw: '',
  itemClass: 'weapon.warstaff',
  baseType: 'Hefty Quarterstaff',
  name: 'Blood Beam',
  itemLevel: 70,
  quality: 0,
  corrupted: false,
  explicits: [
    mod('691932474', '+273 to Accuracy Rating · +105 to Accuracy Rating', 'prefix', 3),
    mod('1037193709', 'Adds 54 to 82 Cold Damage', 'prefix', 4),
    mod('1509134228', '51% increased Physical Damage', 'prefix', 4),
    mod('791928121', 'Causes 50% increased Stun Buildup', 'suffix', 4),
    mod('1368271171', 'Gain 3 Mana per enemy killed', 'suffix', 8)
  ],
  implicits: [],
  openPrefixes: 0,
  openSuffixes: 1,
  weapon: { pdps: 117.7, edps: 88.4, aps: 1.3, critChance: 10 }
}

const v = (p: Partial<Valuation>): Valuation => ({
  verdict: 'buono',
  confidence: 'media',
  comparablesCount: 0,
  warnings: [],
  ...p
})

const BADGES: [string, BadgeState][] = [
  [
    'Pessimo',
    {
      type: 'result',
      item: ITEM,
      exaltedPerDivine: RATE,
      valuation: v({
        verdict: 'pessimo',
        confidence: 'alta',
        price: { suggested: 2, min: 1, max: 3 },
        comparablesCount: 41
      })
    }
  ],
  [
    'Buono',
    {
      type: 'result',
      item: ITEM,
      exaltedPerDivine: RATE,
      valuation: v({ price: { suggested: 18, min: 12, max: 25 }, comparablesCount: 17 })
    }
  ],
  [
    'Ottimo · con avviso',
    {
      type: 'result',
      item: ITEM,
      exaltedPerDivine: RATE,
      valuation: v({
        verdict: 'ottimo',
        confidence: 'bassa',
        price: { suggested: 120, min: 90, max: 160 },
        comparablesCount: 6,
        warnings: [
          "Pochi oggetti simili raccolti: il verdetto è indicativo, usa l'analisi approfondita"
        ]
      })
    }
  ],
  [
    'Eccellente',
    {
      type: 'result',
      item: ITEM,
      exaltedPerDivine: RATE,
      valuation: v({
        verdict: 'eccellente',
        price: { suggested: 450, min: 350, max: 600 },
        comparablesCount: 4,
        warnings: [
          'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'
        ]
      })
    }
  ],
  [
    'Dati insufficienti',
    {
      type: 'result',
      item: ITEM,
      exaltedPerDivine: RATE,
      valuation: v({
        verdict: null,
        confidence: 'bassa',
        warnings: ["Non ho abbastanza oggetti simili per valutarlo: usa l'analisi approfondita"]
      })
    }
  ],
  ['Caricamento', { type: 'loading' }],
  [
    'Errore · testo avanzato',
    {
      type: 'error',
      busy: false,
      title: 'Impossibile valutare',
      message: "Serve la descrizione avanzata: copia l'oggetto con Ctrl+Alt+C e riprova"
    }
  ],
  [
    'Errore · nessun oggetto',
    {
      type: 'error',
      busy: false,
      title: 'Impossibile valutare',
      message: 'Nessun oggetto trovato: tieni il mouse sopra un oggetto e riprova'
    }
  ],
  [
    'Avviso · analisi già in corso',
    {
      type: 'error',
      busy: true,
      title: 'Analisi già in corso',
      message: 'Attendi che finisca prima di valutare un altro oggetto'
    }
  ],
  [
    'Avviso · oggetto non raro',
    {
      type: 'error',
      busy: false,
      title: 'Oggetto non supportato',
      message: 'Per ora valuto solo gli oggetti rari'
    }
  ]
]

const QUICK = v({ verdict: 'ottimo', price: { suggested: 120, min: 90, max: 160 } })

const PANELS: [string, PanelState][] = [
  [
    'Analisi in corso · 3/8 ricerche',
    {
      item: ITEM,
      quick: QUICK,
      exaltedPerDivine: RATE,
      progress: { done: 2, total: 8 },
      result: null
    }
  ],
  [
    'Analisi completata · usati ed esclusi',
    {
      item: ITEM,
      quick: QUICK,
      exaltedPerDivine: RATE,
      progress: { done: 5, total: 8 },
      result: v({
        verdict: 'ottimo',
        confidence: 'alta',
        price: {
          suggested: 280,
          min: 255,
          max: 420,
          patient: 330,
          typical: 420,
          sample: [250, 265, 280, 290, 300, 320, 340, 360, 380, 420, 460, 520, 600, 750, 900, 1200]
        },
        comparablesCount: 16,
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Standard/abc',
        searches: 5,
        mods: [
          {
            statId: 'explicit.stat_2250533757',
            text: '30% increased Movement Speed',
            tier: 1,
            tierCount: 6,
            status: 'used',
            deltaExalted: 118
          },
          {
            statId: 'explicit.stat_3299347043',
            text: '+74 to maximum Life',
            tier: 6,
            tierCount: 9,
            status: 'used',
            deltaExalted: 96
          },
          {
            statId: 'explicit.stat_1368271171',
            text: 'Gain 3 Mana per enemy killed',
            tier: 8,
            tierCount: 8,
            status: 'unweighted'
          },
          {
            statId: 'explicit.stat_4220027924',
            text: '+38% to Cold Resistance',
            tier: 3,
            tierCount: 8,
            status: 'used',
            deltaExalted: -4
          },
          {
            statId: 'explicit.stat_3261801346',
            text: '+12 to Dexterity',
            tier: 7,
            tierCount: 8,
            status: 'relaxed'
          }
        ],
        warnings: [
          'Gli oggetti simili con uno slot libero si vendono intorno a 350 ex',
          'Stima basata su 3 affissi su 4: per gli altri non ci sono abbastanza oggetti simili'
        ]
      })
    }
  ],
  [
    'Arma · analisi in corso',
    {
      item: WEAPON,
      quick: v({ verdict: 'buono', price: { suggested: 15, min: 8, max: 30 } }),
      exaltedPerDivine: RATE,
      progress: { done: 1, total: 8 },
      result: null
    }
  ],
  [
    'Arma · danni nel DPS',
    {
      item: WEAPON,
      quick: v({ verdict: 'buono', price: { suggested: 15, min: 8, max: 30 } }),
      exaltedPerDivine: RATE,
      progress: { done: 2, total: 8 },
      result: v({
        verdict: 'buono',
        confidence: 'media',
        price: {
          suggested: 12,
          min: 10,
          max: 250,
          patient: 250,
          typical: 250,
          sample: [1, 1, 250, 250, 250, 250, 1250, 1250]
        },
        comparablesCount: 8,
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Standard/def',
        searches: 2,
        mods: [
          {
            statId: 'explicit.stat_691932474',
            text: '+273 to Accuracy Rating · +105 to Accuracy Rating',
            tier: 3,
            tierCount: 9,
            status: 'unweighted'
          },
          {
            statId: 'explicit.stat_1037193709',
            text: 'Adds 54 to 82 Cold Damage',
            tier: 4,
            tierCount: 10,
            status: 'dps'
          },
          {
            statId: 'explicit.stat_1509134228',
            text: '51% increased Physical Damage',
            tier: 4,
            tierCount: 8,
            status: 'dps'
          },
          {
            statId: 'explicit.stat_791928121',
            text: 'Causes 50% increased Stun Buildup',
            tier: 4,
            tierCount: 6,
            status: 'unweighted'
          },
          {
            statId: 'explicit.stat_1368271171',
            text: 'Gain 3 Mana per enemy killed',
            tier: 8,
            tierCount: 8,
            status: 'unweighted'
          }
        ]
      })
    }
  ],
  [
    'Bastone · stima incerta',
    {
      item: { ...ITEM, itemClass: 'weapon.staff', name: 'Loath Spell', baseType: 'Roaring Staff' },
      quick: QUICK,
      exaltedPerDivine: 640,
      progress: { done: 7, total: 8 },
      result: v({
        verdict: 'ottimo',
        confidence: 'bassa',
        price: {
          suggested: 152,
          min: 91,
          max: 640,
          patient: 335,
          typical: 640,
          sample: [30, 640, 6400]
        },
        comparablesCount: 3,
        searches: 7,
        uncertain: ['solo 3 oggetti simili in vendita', 'confronto su 1 affisso su 4'],
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Standard/ghi',
        mods: [
          {
            statId: 'explicit.stat_1050105434',
            text: '+185 to maximum Mana',
            tier: 4,
            tierCount: 11,
            status: 'relaxed'
          },
          {
            statId: 'explicit.stat_2254480358',
            text: '+3 to Level of all Cold Spell Skills',
            tier: 3,
            tierCount: 5,
            status: 'used',
            deltaExalted: 148
          },
          {
            statId: 'explicit.stat_2891184298',
            text: '28% increased Cast Speed',
            tier: 5,
            tierCount: 7,
            status: 'relaxed'
          },
          {
            statId: 'explicit.stat_328541901',
            text: '+24 to Intelligence',
            tier: 4,
            tierCount: 8,
            status: 'relaxed'
          }
        ]
      })
    }
  ]
]

/** API finta per la finestra impostazioni nella galleria. */
const fakeApi: PoeApi = {
  onResult: () => () => {},
  onProgress: () => () => {},
  onStarted: () => () => {},
  onAnalyzing: () => () => {},
  onDismiss: () => () => {},
  requestDeep: () => {},
  cancelDeep: () => {},
  setInteractive: () => {},
  getSettings: async () => DEFAULT_SETTINGS,
  getLeagues: async () => ['Runes of Aldur', 'HC Runes of Aldur', 'Standard', 'Hardcore'],
  onLeagues: () => () => {},
  setSettings: async () => DEFAULT_SETTINGS
}

function Cell({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ color: '#9aa1ad', fontSize: 12, marginBottom: 6 }}>{label}</figcaption>
      {children}
    </figure>
  )
}

function Demo(): JSX.Element {
  const grid = { display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' } as const
  return (
    <div style={{ padding: 24, display: 'grid', gap: 32 }}>
      <div style={grid}>
        {BADGES.map(([label, state]) => (
          <Cell key={label} label={label}>
            <VerdictBadge state={state} deepHotkey="Alt+Shift+D" onDeep={() => {}} />
          </Cell>
        ))}
      </div>
      <div style={grid}>
        {PANELS.map(([label, state]) => (
          <Cell key={label} label={label}>
            <ItemPanel state={state} league="Standard" onClose={() => {}} />
          </Cell>
        ))}
        <Cell label="Impostazioni">
          <div style={{ width: 470 }}>
            <SettingsWindow />
          </div>
        </Cell>
      </div>
    </div>
  )
}

export function renderDemo(root: Root): void {
  if (!window.poe) window.poe = fakeApi
  document.body.style.background = 'linear-gradient(160deg, #1d1713, #0d0f0e 55%, #17110e)'
  root.render(<Demo />)
}
