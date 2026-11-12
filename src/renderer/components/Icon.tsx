// Icone SVG inline del mockup. Ogni verdetto ha una forma diversa (non dipende solo dal colore).
import type { JSX } from 'react'

const PATHS = {
  pessimo: 'M2.5 5h19L12 21z',
  ottimo: 'M12 3l9.5 16h-19z',
  eccellente: 'M12 1.5l3.1 6.9 7.4.7-5.6 5 1.6 7.4L12 17.7l-6.5 3.8 1.6-7.4-5.6-5 7.4-.7z',
  warn: 'M12 2L1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  error:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm4.2 12.8l-1.4 1.4L12 13.4l-2.8 2.8-1.4-1.4L10.6 12 7.8 9.2l1.4-1.4L12 10.6l2.8-2.8 1.4 1.4L13.4 12z',
  clock:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm-1 3v6l5 3 1-1.7-4-2.3V7z',
  close:
    'M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z',
  ext: 'M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v8H3V5z'
} as const

export type IconName = keyof typeof PATHS | 'buono'

export function Icon({ name }: { name: IconName }): JSX.Element {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {name === 'buono' ? <circle cx="12" cy="12" r="8" /> : <path d={PATHS[name]} />}
    </svg>
  )
}

/** Indicatore di affidabilità a tre tacche, con l'etichetta opzionale accanto. */
export function ConfidenceBars({
  level,
  label
}: {
  level: 1 | 2 | 3
  label?: string
}): JSX.Element {
  return (
    <span className={`conf c${level}`}>
      <i />
      <i />
      <i />
      {label}
    </span>
  )
}
