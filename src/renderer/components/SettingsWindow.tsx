// Finestra impostazioni: lega, hotkey, soglie del verdetto, raccolta dati.
import { useEffect, useState, type JSX, type KeyboardEvent } from 'react'
import { hotkeysError, type Settings } from '../../core/settings'
import { hotkeyFromKeyEvent, hotkeyParts } from '../format'
import { Icon } from './Icon'

type HotkeyName = keyof Settings['hotkeys']
type ThresholdName = keyof Settings['thresholds']

/** Stato del modulo: i numeri restano testo finché non si salva (campo vuoto = non valido). */
interface Form {
  league: string
  hotkeys: Settings['hotkeys']
  thresholds: Record<ThresholdName, string>
  backgroundCollection: boolean
  maxListingAgeDays: string
}

const toForm = (s: Settings): Form => ({
  league: s.league,
  hotkeys: { ...s.hotkeys },
  thresholds: {
    buono: String(s.thresholds.buono),
    ottimo: String(s.thresholds.ottimo),
    eccellente: String(s.thresholds.eccellente)
  },
  backgroundCollection: s.backgroundCollection,
  maxListingAgeDays: String(s.maxListingAgeDays)
})

/** Numero >= 0 dal campo di testo; null se non valido. */
function parseNum(text: string): number | null {
  if (text.trim() === '') return null
  const n = Number(text.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Impostazioni dal modulo; null se un campo non è valido (soglie anche in ordine crescente,
 * hotkey diverse tra loro e da Ctrl+Alt+C).
 */
function fromForm(f: Form): Settings | null {
  const buono = parseNum(f.thresholds.buono)
  const ottimo = parseNum(f.thresholds.ottimo)
  const eccellente = parseNum(f.thresholds.eccellente)
  const age = parseNum(f.maxListingAgeDays)
  if (f.league.trim() === '' || buono === null || ottimo === null || eccellente === null) {
    return null
  }
  if (age === null || age < 1 || !(buono < ottimo && ottimo < eccellente)) return null
  if (hotkeysError(f.hotkeys) !== null) return null
  return {
    league: f.league.trim(),
    hotkeys: f.hotkeys,
    thresholds: { buono, ottimo, eccellente },
    backgroundCollection: f.backgroundCollection,
    maxListingAgeDays: age
  }
}

const THRESHOLDS: { key: ThresholdName; label: string }[] = [
  { key: 'buono', label: 'Buono' },
  { key: 'ottimo', label: 'Ottimo' },
  { key: 'eccellente', label: 'Eccellente' }
]

function HotkeyField({
  label,
  value,
  capturing,
  onToggle,
  onCaptured
}: {
  label: string
  value: string
  capturing: boolean
  onToggle: () => void
  onCaptured: (hotkey: string) => void
}): JSX.Element {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!capturing) return
    e.preventDefault()
    if (e.key === 'Escape') return onToggle()
    const hk = hotkeyFromKeyEvent(e)
    if (hk) onCaptured(hk)
  }
  return (
    <div className="field">
      <span className="f-label">{label}</span>
      <span>
        {capturing ? (
          <span className="keys capturing">Premi la nuova combinazione</span>
        ) : (
          <span className="keys">
            {hotkeyParts(value).map((k, i) => (
              <span key={i}>
                {i > 0 && '+'}
                <kbd>{k}</kbd>
              </span>
            ))}
          </span>
        )}
        <button className="btn ghost" onClick={onToggle} onKeyDown={onKeyDown}>
          {capturing ? 'Annulla' : 'Cambia'}
        </button>
      </span>
    </div>
  )
}

export function SettingsWindow(): JSX.Element {
  const [form, setForm] = useState<Form | null>(null)
  const [capturing, setCapturing] = useState<HotkeyName | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.poe.getSettings().then((s) => setForm(toForm(s)))
  }, [])

  if (!form) return <div className="window fill" />

  const valid = fromForm(form)
  const update = (patch: Partial<Form>): void => setForm({ ...form, ...patch })
  const close = (): void => window.close()
  const save = async (): Promise<void> => {
    if (!valid) return
    try {
      await window.poe.setSettings(valid)
      close()
    } catch {
      setError('Salvataggio non riuscito: riprova')
    }
  }
  const t = form.thresholds
  const thrInvalid = (key: ThresholdName): boolean => parseNum(t[key]) === null
  const [b, o, e] = [parseNum(t.buono), parseNum(t.ottimo), parseNum(t.eccellente)]
  const unordered = b !== null && o !== null && e !== null && !(b < o && o < e)
  const hotkeyProblem = hotkeysError(form.hotkeys)

  return (
    <div className="window fill">
      <div className="w-title">
        <span className="w-logo" />
        POEvaluator · Impostazioni
        <button className="icon-btn" aria-label="Chiudi" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="w-body">
        <div className="w-group">
          <h4>Generale</h4>
          <div className="field">
            <label htmlFor="league">
              <span className="f-label">Lega</span>
              <span className="f-help">Nome esatto della lega in cui cercare i prezzi</span>
            </label>
            <input
              id="league"
              className="input wide"
              value={form.league}
              aria-invalid={form.league.trim() === ''}
              onChange={(e) => update({ league: e.target.value })}
            />
          </div>
        </div>

        <div className="w-group">
          <h4>Hotkey</h4>
          {(
            [
              ['quick', 'Valutazione rapida'],
              ['deep', 'Analisi approfondita']
            ] as const
          ).map(([key, label]) => (
            <HotkeyField
              key={key}
              label={label}
              value={form.hotkeys[key]}
              capturing={capturing === key}
              onToggle={() => setCapturing(capturing === key ? null : key)}
              onCaptured={(hk) => {
                update({ hotkeys: { ...form.hotkeys, [key]: hk } })
                setCapturing(null)
              }}
            />
          ))}
        </div>

        <div className="w-group">
          <h4>Soglie del verdetto</h4>
          <div className="thr">
            {THRESHOLDS.map(({ key, label }) => (
              <div className={`v-${key}`} key={key}>
                <label className="lbl" htmlFor={`thr-${key}`}>
                  <Icon name={key} />
                  {label}
                </label>
                <span className="val">
                  da
                  <input
                    id={`thr-${key}`}
                    className="input num"
                    inputMode="decimal"
                    value={t[key]}
                    aria-invalid={thrInvalid(key)}
                    onChange={(e) => update({ thresholds: { ...t, [key]: e.target.value } })}
                  />
                  ex
                </span>
              </div>
            ))}
          </div>
          <div className="scale">
            <span className="v-pessimo" style={{ flex: 1 }}>
              <Icon name="pessimo" />
              &lt; {t.buono}
            </span>
            <span className="v-buono" style={{ flex: 1.4 }}>
              <Icon name="buono" />
              {t.buono}–{t.ottimo}
            </span>
            <span className="v-ottimo" style={{ flex: 1.8 }}>
              <Icon name="ottimo" />
              {t.ottimo}–{t.eccellente}
            </span>
            <span className="v-eccellente" style={{ flex: 1.2 }}>
              <Icon name="eccellente" />≥ {t.eccellente}
            </span>
          </div>
        </div>

        <div className="w-group">
          <h4>Raccolta dati</h4>
          <div className="field">
            <div>
              <span className="f-label">Raccolta in background</span>
              <span className="f-help">
                Mentre giochi scarica inserzioni dal trade senza superare i limiti: la valutazione
                rapida diventa più precisa
              </span>
            </div>
            <span className="inline">
              <span className="toggle-txt">{form.backgroundCollection ? 'Attiva' : 'Spenta'}</span>
              <button
                className="toggle"
                role="switch"
                aria-checked={form.backgroundCollection}
                aria-label="Raccolta in background"
                onClick={() => update({ backgroundCollection: !form.backgroundCollection })}
              />
            </span>
          </div>
          <div className="field">
            <label htmlFor="max-age">
              <span className="f-label">Età massima delle inserzioni</span>
              <span className="f-help">Le inserzioni più vecchie vengono ignorate</span>
            </label>
            <span className="inline">
              <input
                id="max-age"
                className="input num"
                inputMode="numeric"
                value={form.maxListingAgeDays}
                aria-invalid={(parseNum(form.maxListingAgeDays) ?? 0) < 1}
                onChange={(e) => update({ maxListingAgeDays: e.target.value })}
              />
              giorni
            </span>
          </div>
        </div>
      </div>
      <div className="w-foot">
        <span className="saved">
          {hotkeyProblem ?? (unordered ? 'Le soglie devono essere in ordine crescente' : error)}
        </span>
        <button className="btn ghost" onClick={close}>
          Annulla
        </button>
        <button className="btn" disabled={!valid} onClick={() => void save()}>
          Salva
        </button>
      </div>
    </div>
  )
}
