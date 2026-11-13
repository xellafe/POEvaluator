// Pannello dell'analisi approfondita: in corso (avanzamento + stima rapida) e completata.
import type { CSSProperties, JSX } from 'react'
import type { ProgressPayload } from '../../core/ipc'
import type { DeepMod, RareItem, Valuation } from '../../core/types'
import { modStatuses } from '../../core/valuation/mod-status'
import {
  analysisAge,
  CONFIDENCE_LEVEL,
  distributionLayout,
  formatDelta,
  formatPrice,
  foundPrices,
  itemClassLabel,
  modStatusTitle,
  priceParts,
  tierBand,
  tierTitle,
  uncertainText,
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
  /** Contributi degli affissi chiesti dall'utente (R37): in corso o non riusciti. */
  contrib?: ContribState
}

export type ContribState =
  | { status: 'running'; progress: ProgressPayload }
  | { status: 'error'; title: string; message: string }

interface Props {
  state: PanelState
  league: string
  onClose: () => void
  /** Pulsante "Calcola il contributo" (R37). */
  onContributions?: () => void
}

/** Barra e testo "Ricerca X di N sul trade" (analisi e contributi). */
function Progress({ progress }: { progress: ProgressPayload }): JSX.Element {
  const total = Math.max(1, progress.total)
  const current = Math.min(progress.done + 1, total)
  return (
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
  )
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
        <Progress progress={progress} />
        <div className="p-prelim">
          Stima rapida: <b>{quickText}</b>
        </div>
      </div>
      {item.explicits.length > 0 && (
        <div className="p-sec">
          <h4>Contributo degli affissi</h4>
          {/* durante l'analisi lo stato viene da oggetto e pesi; "relaxed" si sa solo alla fine */}
          <ModList mods={modStatuses(item)} mode="pending" />
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

/**
 * Testo di un affisso con il tier a sinistra ("T3"), colorato in base al tier; senza tier un
 * segnaposto vuoto tiene allineati i testi.
 */
function ModText({ mod }: { mod: DeepMod }): JSX.Element {
  return (
    <span className="mod">
      <span
        className={`tier ${tierBand(mod.tier, mod.tierCount)}`}
        title={mod.tier !== undefined ? tierTitle(mod.tier, mod.tierCount) : undefined}
      >
        {mod.tier !== undefined ? `T${mod.tier}` : ''}
      </span>
      <span className="txt">{mod.text}</span>
    </span>
  )
}

/**
 * Tutti gli affissi dell'oggetto nell'ordine del testo (R34): usati (barra del contributo, "in
 * attesa" con `pending`, solo il testo con `idle` = contributi da calcolare, R37), nel DPS
 * (etichetta), esclusi (grigi, con il motivo nel tooltip).
 */
function ModList({
  mods,
  mode = 'done'
}: {
  mods: DeepMod[]
  mode?: 'pending' | 'idle' | 'done'
}): JSX.Element {
  const maxDelta = Math.max(1e-9, ...mods.map((m) => Math.abs(m.deltaExalted ?? 0)))
  return (
    <ul className="contrib">
      {mods.map((m, i) => {
        const key = `${m.statId}-${i}`
        if (m.status === 'dps') {
          return (
            <li className="dps" key={key}>
              <ModText mod={m} />
              <span className="tag">nel DPS</span>
            </li>
          )
        }
        if (m.status !== 'used') {
          return (
            <li className="excluded" key={key} title={modStatusTitle(m.status)}>
              <ModText mod={m} />
            </li>
          )
        }
        if (mode === 'idle') {
          return (
            <li className="idle" key={key}>
              <ModText mod={m} />
            </li>
          )
        }
        if (mode === 'pending') {
          return (
            <li className="pending" key={key}>
              <ModText mod={m} />
              <span className="bar" />
              <span className="delta wait">in attesa</span>
            </li>
          )
        }
        const d = m.deltaExalted
        if (d === undefined) {
          return (
            <li
              key={key}
              title="Contributo non calcolato: pochi oggetti simili o ricerche esaurite"
            >
              <ModText mod={m} />
              <span className="bar" />
              <span className="delta wait">n.d.</span>
            </li>
          )
        }
        const neg = d < 0
        const width = `${Math.round((Math.abs(d) / maxDelta) * 100)}%`
        return (
          <li key={key}>
            <ModText mod={m} />
            <span className={neg ? 'bar neg' : 'bar'}>
              <span style={{ '--w': width } as CSSProperties} />
            </span>
            <span className={neg ? 'delta neg' : 'delta pos'}>{formatDelta(d)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Barra sottile con i prezzi del campione (scala log) e i marcatori p10, p25 e p50 (R34);
 * senza marcatori per una stima incerta (i percentili su pochi prezzi non dicono nulla).
 */
function Distribution({
  sample,
  p10,
  p25,
  p50,
  marks = true
}: {
  sample: number[]
  p10: number
  p25: number
  p50: number
  marks?: boolean
}): JSX.Element {
  const d = distributionLayout(sample, { p10, p25, p50 })
  return (
    <div className="p-dist" aria-hidden="true">
      {d.dots.map((x, i) => (
        <i key={i} style={{ left: `${x}%` }} />
      ))}
      {marks && (
        <>
          <b className="m-p50" style={{ left: `${d.marks.p50}%` }} />
          <b className="m-p25" style={{ left: `${d.marks.p25}%` }} />
          <b className="m-p10" style={{ left: `${d.marks.p10}%` }} />
        </>
      )}
    </div>
  )
}

/**
 * Sezione "Contributo degli affissi". Contributi da calcolare (R37): righe senza barra e pulsante
 * con il numero di ricerche; durante il calcolo righe "in attesa" e avanzamento; un errore resta
 * sotto la sezione con il pulsante per riprovare.
 */
function ContribSection({
  mods,
  v,
  contrib,
  onContributions
}: {
  mods: DeepMod[]
  v: Valuation
  contrib?: ContribState
  onContributions?: () => void
}): JSX.Element {
  const onDemand = v.contributions === 'available'
  const running = onDemand && contrib?.status === 'running'
  const mode = !onDemand ? 'done' : running ? 'pending' : 'idle'
  const used = mods.filter((m) => m.status === 'used').length
  const planned = v.basis?.plannedSearches ?? used + 1
  const hasDeltas = mods.some((m) => m.deltaExalted !== undefined)
  return (
    <div className="p-sec">
      <h4>Contributo degli affissi</h4>
      <ModList mods={mods} mode={mode} />
      {onDemand && contrib?.status === 'running' && <Progress progress={contrib.progress} />}
      {onDemand && !running && (
        <div className="contrib-act">
          <button className="btn ghost" onClick={onContributions}>
            Calcola il contributo
          </button>
          <span>
            Circa {planned} {planned === 1 ? 'ricerca' : 'ricerche'} sul trade
          </span>
        </div>
      )}
      {onDemand && contrib?.status === 'error' && (
        <div className="contrib-err" role="alert">
          <b>{contrib.title}.</b> {contrib.message}
        </div>
      )}
      {!onDemand && hasDeltas && (
        <div className="contrib-note">
          Differenza di prezzo tra oggetti simili con e senza l&apos;affisso.
        </div>
      )}
    </div>
  )
}

function Done({
  state,
  league,
  onClose,
  onContributions
}: Props & { state: PanelState }): JSX.Element {
  const { item, exaltedPerDivine, progress } = state
  const v = state.result as Valuation
  // ricerche realmente eseguite (dato del core); in mancanza, l'ultimo avanzamento ricevuto
  const searches = v.searches ?? progress.done
  const price = v.price ? priceParts(v.price.suggested, exaltedPerDivine) : null
  // analisi salvate prima di R34 non hanno `mods`: stato ricavato da oggetto e pesi
  const mods = v.mods ?? modStatuses(item)
  // stima incerta: niente prezzo consigliato, solo i prezzi trovati e il motivo
  const uncertain = v.verdict !== null && v.uncertain !== undefined && v.uncertain.length > 0
  const prices: [string, number | undefined][] = v.price
    ? [
        ['Vende subito', v.price.suggested],
        ['Se puoi aspettare', v.price.patient],
        ['Richiesta tipica', v.price.typical]
      ]
    : []

  return (
    <div className={`panel v-${v.verdict ?? 'neutral'}`}>
      <Head item={item} onClose={onClose} />
      <div className="p-summary">
        <div className="p-row">
          <span className="p-verdict">
            <Icon name={v.verdict ?? 'warn'} />
            {verdictLabel(v.verdict)}
          </span>
          {uncertain && <span className="p-uncertain">Stima incerta</span>}
        </div>
        {uncertain && v.uncertain && (
          <>
            {v.price?.sample && v.price.sample.length > 0 && (
              <>
                <div className="p-found">
                  <span className="lbl">Prezzi trovati</span>
                  <span className="val">{foundPrices(v.price.sample, exaltedPerDivine)}</span>
                </div>
                <Distribution
                  sample={v.price.sample}
                  p10={v.price.suggested}
                  p25={v.price.suggested}
                  p50={v.price.suggested}
                  marks={false}
                />
              </>
            )}
            <div className="p-uncertain-why">{uncertainText(v.uncertain)}</div>
          </>
        )}
        {!uncertain && price && v.price && (
          <>
            <div className="p-price">
              {price.main} <span className="ex">{price.unit}</span>
            </div>
            <div className="p-prices">
              {prices.map(([label, value]) =>
                value === undefined ? null : (
                  <div key={label}>
                    <span className="lbl">{label}</span>
                    <span className="val">{formatPrice(value, exaltedPerDivine)}</span>
                  </div>
                )
              )}
            </div>
            {v.price.sample && v.price.sample.length > 0 && (
              <Distribution
                sample={v.price.sample}
                p10={v.price.suggested}
                p25={v.price.patient ?? v.price.suggested}
                p50={v.price.typical ?? v.price.suggested}
              />
            )}
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
            <dd>{searches}</dd>
          </div>
        </dl>
      </div>
      {mods.length > 0 && (
        <ContribSection
          mods={mods}
          v={v}
          contrib={state.contrib}
          onContributions={onContributions}
        />
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
