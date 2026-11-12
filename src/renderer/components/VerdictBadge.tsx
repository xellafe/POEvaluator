// Badge del verdetto accanto al cursore: caricamento, valutazione rapida, errori.
import type { JSX } from 'react'
import type { RareItem, Valuation } from '../../core/types'
import {
  CONFIDENCE_LEVEL,
  formatRange,
  hotkeyParts,
  priceParts,
  similarCount,
  verdictLabel
} from '../format'
import { ConfidenceBars, Icon } from './Icon'

export type BadgeState =
  | { type: 'loading' }
  | { type: 'result'; item: RareItem; valuation: Valuation; exaltedPerDivine: number | null }
  | { type: 'error'; title: string; message: string; busy: boolean }

interface Props {
  state: BadgeState
  /** Hotkey dell'analisi approfondita, mostrata nel piede del badge. */
  deepHotkey: string
  /** Click sul badge di un risultato: analisi approfondita. */
  onDeep: () => void
}

/** Mostra i tasti della hotkey come un unico <kbd> ("Alt+Shift+D"), come nel mockup. */
const Keys = ({ hotkey }: { hotkey: string }): JSX.Element => (
  <kbd>{hotkeyParts(hotkey).join('+')}</kbd>
)

/** Testo con le combinazioni "Ctrl+Alt+C" rese come tasti. */
function withKeys(text: string): (string | JSX.Element)[] {
  return text
    .split(/(Ctrl\+Alt\+C)/)
    .map((part, i) => (part === 'Ctrl+Alt+C' ? <kbd key={i}>{part}</kbd> : part))
}

function Warnings({ warnings }: { warnings: string[] }): JSX.Element {
  return (
    <>
      {warnings.map((w) => (
        <div className="warn" key={w}>
          <Icon name="warn" />
          {w}
        </div>
      ))}
    </>
  )
}

export function VerdictBadge({ state, deepHotkey, onDeep }: Props): JSX.Element {
  if (state.type === 'loading') {
    return (
      <div className="badge">
        <div className="b-body">
          <div className="b-verdict plain">
            <span className="spin" />
            Valuto l&apos;oggetto…
          </div>
          <div className="sk" style={{ width: '55%', height: 22 }} />
          <div className="sk" style={{ width: '80%' }} />
        </div>
        <div className="b-foot">Confronto con le inserzioni raccolte</div>
      </div>
    )
  }

  if (state.type === 'error') {
    return (
      <div className="badge v-neutral" role="alert">
        <div className="b-body">
          <div className="b-verdict plain">
            <Icon name={state.busy ? 'clock' : 'error'} />
            {state.title}
          </div>
          <p className="b-msg">{withKeys(state.message)}</p>
        </div>
        <div className="b-foot">
          <kbd>Esc</kbd> per chiudere
        </div>
      </div>
    )
  }

  const { item, valuation: v, exaltedPerDivine } = state
  const price = v.price ? priceParts(v.price.suggested, exaltedPerDivine) : null
  const meta = [
    v.price ? `Prezzi ${formatRange(v.price.min, v.price.max, exaltedPerDivine)}` : null,
    v.comparablesCount > 0 ? similarCount(v.comparablesCount) : null
  ].filter((s): s is string => s !== null)

  return (
    <div
      className={`badge clickable v-${v.verdict}`}
      role="button"
      tabIndex={-1}
      title="Analisi approfondita"
      onClick={onDeep}
    >
      <div className="b-body">
        <div className="b-top">
          <span>{item.name}</span>
          <ConfidenceBars level={CONFIDENCE_LEVEL[v.confidence]} label={v.confidence} />
        </div>
        <div className="b-verdict">
          <Icon name={v.verdict} />
          {verdictLabel(v.verdict)}
        </div>
        {price && (
          <div className="b-price">
            {price.main} <span className="ex">{price.unit}</span>
          </div>
        )}
        {meta.length > 0 && <div className="b-meta">{meta.join(' · ')}</div>}
        <Warnings warnings={v.warnings} />
      </div>
      <div className="b-foot">
        <Keys hotkey={deepHotkey} /> per l&apos;analisi approfondita
      </div>
    </div>
  )
}

export { Warnings }
