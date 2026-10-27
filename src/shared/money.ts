/** Integer micro-dollars. Token counts times per-million-token prices land on whole micros. */
export type Micros = number & { readonly __brand: "Micros" }

export const micros = (n: number): Micros => n as Micros

export const ZERO = micros(0)

export const addMicros = (a: Micros, b: Micros): Micros => micros(a + b)

export const toUsd = (m: Micros): string => `${m < 0 ? "-" : ""}$${(Math.abs(m) / 1e6).toFixed(2)}`

export function toDecimal(m: Micros): string {
  return `${Math.trunc(m / 1e6)}.${String(m % 1e6).padStart(6, "0")}`
}
