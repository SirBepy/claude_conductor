/** `1 answer`, `3 answers`; `many` for an irregular plural (`1 reply`, `2 replies`). */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
