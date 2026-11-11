// POEvaluator shim: replaces EE2's `@/web/Config` and `@/web/overlay/widgets`
// (Vue app configuration) with the fixed values the parser needs outside the overlay.

export interface PriceCheckWidget {
  /** Augments EE2 pre-fills into empty rune sockets; POEvaluator never does that. */
  savedAugments: Record<string, Array<string | null> | undefined>
}

interface ParserConfig extends PriceCheckWidget {
  language: string
}

const CONFIG: ParserConfig = { language: 'en', savedAugments: {} }

export function AppConfig<T = ParserConfig>(_type?: string): T {
  return CONFIG as unknown as T
}
