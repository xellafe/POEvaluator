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

const mod = (text: string, i: number): RareItem['explicits'][number] => ({
  statId: `explicit.stat_${i}`,
  text,
  values: [],
  tradeValue: 1,
  type: i % 2 ? 'suffix' : 'prefix'
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
    '30% increased Movement Speed',
    '+74 to maximum Life',
    '+38% to Cold Resistance',
    '+12 to Dexterity'
  ].map(mod),
  implicits: [],
  openPrefixes: 0,
  openSuffixes: 0
}

const RATE = 250

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
    'Analisi completata',
    {
      item: ITEM,
      quick: QUICK,
      exaltedPerDivine: RATE,
      progress: { done: 5, total: 8 },
      result: v({
        verdict: 'ottimo',
        confidence: 'alta',
        price: { suggested: 280, min: 220, max: 340 },
        comparablesCount: 23,
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Standard/abc',
        searches: 5,
        contributions: [
          { statId: 'a', text: '30% increased Movement Speed', deltaExalted: 118 },
          { statId: 'b', text: '+74 to maximum Life', deltaExalted: 96 },
          { statId: 'c', text: '+38% to Cold Resistance', deltaExalted: 22 },
          { statId: 'd', text: '+12 to Dexterity', deltaExalted: -4 }
        ],
        warnings: ['Gli oggetti simili con uno slot libero si vendono intorno a 350 ex']
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
