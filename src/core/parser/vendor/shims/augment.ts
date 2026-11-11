// POEvaluator shim: replaces EE2's `@/web/price-check/item-editor/augment` (Vue item editor).
// EE2 calls it only to apply the user's saved augments to empty sockets; the config shim
// provides no saved augments, so this is never reached with real data.

import type { EditorItem, ParsedItem } from '../parser/ParsedItem'

export function useAugment(_item: ParsedItem, _augment: EditorItem, _index: number): void {}
