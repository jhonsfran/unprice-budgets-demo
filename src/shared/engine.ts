import { type Micros, ZERO, addMicros, micros } from "./money"
import { type CallSpec, type Variance, callSpec } from "./sim"

export type Remedy = "release_holds" | "wait_for_reset" | "raise_limit"

export type GateEvent =
  | { type: "started"; agent: number; reserved: Micros }
  | { type: "finished"; agent: number; actual: Micros; reserved: Micros }
  | { type: "decided"; agent: number; ms: number; allowed: boolean }
  | { type: "denied"; agent: number; remedy: Remedy }
  | { type: "blocked"; agent: number }
  | { type: "stopped"; agent: number }

/** `t` is milliseconds since the panel started. */
export type PanelEvent = GateEvent & { t: number }

export type Emit = (event: GateEvent) => void

/** `retry` runs the same call again, so both panels still see the identical sequence of calls. */
export type Gate = {
  run(spec: CallSpec, work: () => Promise<void>, emit: Emit): Promise<"continue" | "retry" | "stop">
}

export type Sleep = (ms: number) => Promise<void>

export async function runPanel({
  gate,
  seed,
  agents,
  variance,
  sleep,
  signal,
  emit,
}: {
  gate: Gate
  seed: number
  agents: number
  variance: Variance
  sleep: Sleep
  signal: AbortSignal
  emit: (event: PanelEvent) => void
}): Promise<void> {
  const start = performance.now()
  const stamp: Emit = (event) => emit({ ...event, t: performance.now() - start })

  const agent = async (id: number) => {
    for (let index = 0; !signal.aborted; ) {
      const spec = callSpec(seed, id, index, variance)
      const next = await gate.run(spec, () => sleep(spec.latencyMs), stamp)
      if (next === "stop") break
      if (next === "continue") index++
    }
    stamp({ type: "stopped", agent: id })
  }
  await Promise.all(Array.from({ length: agents }, (_, id) => agent(id)))
}

export type SeriesPoint = { t: number; spent: Micros; held: Micros }

export type PanelState = {
  cap: Micros
  agents: number
  spent: Micros
  held: Micros
  inFlight: number
  calls: number
  denied: number
  /** The moment recorded spend first reached the cap, with the calls still running past it. */
  alert: null | { t: number; spent: Micros; inFlight: number }
  firstDenial: null | { t: number; spent: Micros; held: Micros }
  /** How long each reserve took to answer, in milliseconds, and whether it let the call run. */
  decisions: { ms: number; allowed: boolean }[]
  series: SeriesPoint[]
  stoppedAgents: number
  done: boolean
}

export const initialPanel = (cap: Micros, agents: number): PanelState => ({
  cap,
  agents,
  spent: ZERO,
  held: ZERO,
  inFlight: 0,
  calls: 0,
  denied: 0,
  alert: null,
  firstDenial: null,
  decisions: [],
  series: [{ t: 0, spent: ZERO, held: ZERO }],
  stoppedAgents: 0,
  done: false,
})

const withPoint = (state: PanelState, t: number): PanelState => ({
  ...state,
  series: [...state.series, { t, spent: state.spent, held: state.held }],
})

export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "started":
      return withPoint(
        { ...state, held: addMicros(state.held, event.reserved), inFlight: state.inFlight + 1 },
        event.t,
      )
    case "finished": {
      const next: PanelState = {
        ...state,
        spent: addMicros(state.spent, event.actual),
        held: micros(state.held - event.reserved),
        inFlight: state.inFlight - 1,
        calls: state.calls + 1,
      }
      const crossed = state.alert === null && next.spent >= state.cap
      return withPoint(
        crossed ? { ...next, alert: { t: event.t, spent: next.spent, inFlight: next.inFlight } } : next,
        event.t,
      )
    }
    case "decided":
      return { ...state, decisions: [...state.decisions, { ms: event.ms, allowed: event.allowed }] }
    case "denied":
      return {
        ...state,
        denied: state.denied + 1,
        firstDenial: state.firstDenial ?? { t: event.t, spent: state.spent, held: state.held },
      }
    case "blocked":
      return state
    case "stopped": {
      const stoppedAgents = state.stoppedAgents + 1
      return { ...state, stoppedAgents, done: stoppedAgents === state.agents }
    }
  }
}
