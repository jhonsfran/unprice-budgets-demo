import { type Micros, micros } from "./money"

export type Variance = "low" | "med" | "high"

type Range = readonly [min: number, max: number]

const PRESETS: Record<Variance, { input: Range; output: Range }> = {
  low: { input: [24_000, 28_000], output: [900, 1_300] },
  med: { input: [12_000, 40_000], output: [300, 2_500] },
  high: { input: [4_000, 80_000], output: [50, 4_096] },
}

export const INPUT_MICROS_PER_TOKEN = 3
export const OUTPUT_MICROS_PER_TOKEN = 15
export const MAX_OUTPUT_TOKENS = 4_096
const LATENCY_MS: Range = [300, 1_500]

export type CallSpec = {
  agent: number
  index: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  /** Worst case: the full prompt plus maxOutputTokens of output. */
  estimate: Micros
  actual: Micros
}

/** mulberry32 seeded from a mix of the triple, so call k of agent i is the same in every panel. */
function random(seed: number, agent: number, index: number): () => number {
  let state = (seed ^ Math.imul(agent + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const draw = (next: () => number, [min, max]: Range): number => min + Math.floor(next() * (max - min + 1))

export function callSpec(seed: number, agent: number, index: number, variance: Variance): CallSpec {
  const next = random(seed, agent, index)
  const preset = PRESETS[variance]
  const latencyMs = draw(next, LATENCY_MS)
  const inputTokens = draw(next, preset.input)
  const outputTokens = draw(next, preset.output)
  const inputCost = inputTokens * INPUT_MICROS_PER_TOKEN
  return {
    agent,
    index,
    latencyMs,
    inputTokens,
    outputTokens,
    estimate: micros(inputCost + MAX_OUTPUT_TOKENS * OUTPUT_MICROS_PER_TOKEN),
    actual: micros(inputCost + outputTokens * OUTPUT_MICROS_PER_TOKEN),
  }
}
