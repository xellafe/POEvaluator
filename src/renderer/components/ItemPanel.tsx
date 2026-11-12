// Pannello dell'analisi approfondita: in corso (avanzamento + stima rapida) e completata.
import type { CSSProperties, JSX } from 'react'
import type { ProgressPayload } from '../../core/ipc'
import type { RareItem, Valuation } from '../../core/types'
import {
  analysisAge,
  CONFIDENCE_LEVEL,
  formatDelta,
  formatExalted,
  formatPrice,
  formatRange,
  itemClassLabel,
  priceParts,
  verdictLabel
} from '../format'
import { ConfidenceBars, Icon } from './Icon'
import { Warnings } from './VerdictBadge'

export interface PanelState {
  item: RareItem
  /** Stima rapida calcolata prima dell'analisi. */
  quick: Valuation
  exaltedPerDivine: number | null
  progress: ProgressPayload
  /** Risultato dell'analisi; null finché è in corso. */
  result: Valuation | null
}

interface Props {
  state: PanelState
  league: string
  onClose: () => void
}

function Head({ item, onClose }: { item: RareItem; onClose: () => void }): JSX.Element {
  return (
    <header className="p-head">
      <div>
        <div className="p-kicker">Analisi approfondita · {itemClassLabel(item.itemClass)}</div>
        <div className="p-name">{item.name}</div>
        <div className="p-base">{item.baseType}</div>
      </div>
      <button className="icon-btn" aria-label="Chiudi" onClick={onClose}>
        <Icon name="close" />
      </button>
    </header>
  )
}

function Running({ state, onClose }: { state: PanelState; onClose: () => void }): JSX.Element {
  const { item, quick, exaltedPerDivine, progress } = state
  const total = Math.max(1, progress.total)
  const current = Math.min(progress.done + 1, total)
  const quickText = [
    verdictLabel(quick.verdict),
    quick.price ? formatPrice(quick.price.suggested, exaltedPerDivine) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="panel">
      <Head item={item} onClose={onClose} />
      <div className="p-summary">
        <span className="p-verdict pending">
          <span className="spin" />
          Analisi in corso…
        </span>
        <div className="p-progress">
          <div className="track">
            <span style={{ width: `${(Math.min(progress.done, total) / total) * 100}%` }} />
          </div>
          <div className="p-progress-txt">
            <span>
              Ricerca {current} di {total} sul trade
            </span>
          </div>
        </div>
        <div className="p-prelim">
          Stima rapida: <b>{quickText}</b>
        </div>
      </div>
      {item.explicits.length > 0 && (
        <div className="p-sec">
          <h4>Contributo degli affissi</h4>
          <ul className="contrib">
            {item.explicits.map((m, i) => (
              <li className="pending" key={`${m.statId}-${i}`}>
                <span className="mod">{m.text}</span>
                <span className="bar" />
                <span className="delta wait">in attesa</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className="p-foot">
        <span>Le ricerche sono rallentate per rispettare i limiti del sito del trade</span>
        <a className="btn ghost" aria-disabled="true">
          Apri sul trade
          <Icon name="ext" />
        </a>
      </footer>
    </div>
  )
}

/** Posizione (in %) di fascia e prezzo consigliato su una scala con margine ai lati. */
function rangeBar(
  min: number,
  max: number,
  suggested: number
): { span: CSSProperties; mark: CSSProperties } {
  const pad = (max - min) * 0.5
  const lo = min - pad
  const hi = max + pad
  if (hi <= lo) return { span: { left: '40%', right: '40%' }, mark: { left: '50%' } }
  const pct = (v: number): number => ((v - lo) / (hi - lo)) * 100
  return {
    span: { left: `${pct(min)}%`, right: `${100 - pct(max)}%` },
    mark: { left: `${pct(suggested)}%` }
  }
}

function Done({ state, league, onClose }: Props & { state: PanelState }): JSX.Element {
  const { item, exaltedPerDivine, progress } = state
  const v = state.result as Valuation
  // ricerche realmente eseguite (dato del core); in mancanza, l'ultimo avanzamento ricevuto
  const searches = v.searches ?? progress.done
  const price = v.price ? priceParts(v.price.suggested, exaltedPerDivine) : null
  const bar = v.price ? rangeBar(v.price.min, v.price.max, v.price.suggested) : null
  const contributions = [...(v.contributions ?? [])].sort((a, b) => b.deltaExalted - a.deltaExalted)
  const maxDelta = Math.max(1e-9, ...contributions.map((c) => Math.abs(c.deltaExalted)))

  return (
    <div className={`panel v-${v.verdict ?? 'neutral'}`}>
      <Head item={item} onClose={onClose} />
      <div className="p-summary">
        <div className="p-row">
          <span className="p-verdict">
            <Icon name={v.verdict ?? 'warn'} />
            {verdictLabel(v.verdict)}
          </span>
        </div>
        {price && v.price && bar && (
          <>
            <div className="p-price">
              {price.main} <span className="ex">{price.unit}</span>
            </div>
            <div className="p-range-bar">
              <span style={bar.span} />
              <i style={bar.mark} />
            </div>
            <div className="p-range">
              Prezzi {formatRange(v.price.min, v.price.max, exaltedPerDivine)} · consigliato{' '}
              {formatExalted(v.price.suggested)}
            </div>
          </>
        )}
        <dl className="p-stats">
          <div>
            <dt>Affidabilità</dt>
            <dd>
              <ConfidenceBars level={CONFIDENCE_LEVEL[v.confidence]} />
              {v.confidence}
            </dd>
          </div>
          <div>
            <dt>Oggetti simili</dt>
            <dd>{v.comparablesCount}</dd>
          </div>
          <div>
            <dt>Ricerche</dt>
            <dd>
              {searches}/{progress.total}
            </dd>
          </div>
        </dl>
      </div>
      {contributions.length > 0 && (
        <div className="p-sec">
          <h4>Contributo degli affissi</h4>
          <ul className="contrib">
            {contributions.map((c, i) => {
              const neg = c.deltaExalted < 0
              const width = `${Math.round((Math.abs(c.deltaExalted) / maxDelta) * 100)}%`
              return (
                <li key={`${c.statId}-${i}`}>
                  <span className="mod">{c.text}</span>
                  <span className={neg ? 'bar neg' : 'bar'}>
                    <span style={{ '--w': width } as CSSProperties} />
                  </span>
                  <span className={neg ? 'delta neg' : 'delta pos'}>
                    {formatDelta(c.deltaExalted)}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="contrib-note">
            Differenza di prezzo tra oggetti simili con e senza l&apos;affisso.
          </div>
        </div>
      )}
      {v.warnings.length > 0 && (
        <div className="p-sec warns">
          <Warnings warnings={v.warnings} />
        </div>
      )}
      <footer className="p-foot">
        <span>
          Lega {league}
          {v.cachedAt ? ` · ${analysisAge(v.cachedAt, new Date())}` : ''}
        </span>
        {v.tradeUrl ? (
          <a className="btn" href={v.tradeUrl} target="_blank" rel="noreferrer">
            Apri sul trade
            <Icon name="ext" />
          </a>
        ) : (
          <a className="btn" aria-disabled="true">
            Apri sul trade
            <Icon name="ext" />
          </a>
        )}
      </footer>
    </div>
  )
}

export function ItemPanel(props: Props): JSX.Element {
  return props.state.result ? (
    <Done {...props} />
  ) : (
    <Running state={props.state} onClose={props.onClose} />
  )
}
