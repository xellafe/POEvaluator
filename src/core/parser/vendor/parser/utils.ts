// Vendored from Exiled Exchange 2 (https://github.com/Kvan7/Exiled-Exchange-2)
// Source: renderer/src/parser/utils.ts @ cca30662bf31eaf38bd711e2ec1a6b899a06c40e - MIT License, see THIRD_PARTY_NOTICES.md
// POEvaluator changes: import paths rewritten to relative modules / shims only.
export function combinations<T>(arr: T[]): T[][] {
  return arr.reduce<T[][]>(
    (acc, curr) => [...acc, ...acc.map((a) => [...a, curr])],
    [[]],
  );
}

export function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
