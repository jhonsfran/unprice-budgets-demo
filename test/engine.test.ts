import { describe, expect, it } from "vitest"
import { type PanelEvent, type PanelState, initialPanel, panelReducer, runPanel } from "../src/shared/engine"
import { afterTheFactGate } from "../src/shared/gates"
import { micros, toDecimal } from "../src/shared/money"
import { callSpec } from "../src/shared/sim"

const CAP = micros(5_000_000)
const SEED = 20261027
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / 50))

describe("callSpec", () => {
  it("prices a call from its seeded tokens at $3/M input and $15/M output", () => {
    const spec = callSpec(SEED, 3, 7, "med")
    expect(spec.estimate).toBe(spec.inputTokens * 3 + 4096 * 15)
    expect(spec.actual).toBe(spec.inputTokens * 3 + spec.outputTokens * 15)
    expect(callSpec(SEED, 3, 7, "med")).toEqual(spec)
    expect(callSpec(SEED, 3, 8, "med")).not.toEqual(spec)
  })

  it("formats micros as the 6 dp decimal the SDK sends", () => {
    expect(toDecimal(micros(4_970_015))).toBe("4.970015")
    expect(toDecimal(micros(61_440))).toBe("0.061440")
  })
})

describe("panelReducer", () => {
  it("records the alert when spend crosses the cap and the first denial", () => {
    const events: PanelEvent[] = [
      { t: 10, type: "started", agent: 0, reserved: micros(60) },
      { t: 20, type: "started", agent: 1, reserved: micros(60) },
      { t: 30, type: "finished", agent: 0, actual: micros(70), reserved: micros(60) },
      { t: 40, type: "started", agent: 0, reserved: micros(60) },
      { t: 50, type: "finished", agent: 1, actual: micros(40), reserved: micros(60) },
      { t: 55, type: "decided", agent: 1, ms: 42, allowed: false },
      { t: 60, type: "denied", agent: 1, remedy: "release_holds" },
      { t: 70, type: "stopped", agent: 1 },
    ]
    const state = events.reduce(panelReducer, initialPanel(micros(100), 2))
    expect(state).toEqual({
      cap: 100,
      agents: 2,
      spent: 110,
      held: 60,
      inFlight: 1,
      calls: 2,
      denied: 1,
      alert: { t: 50, spent: 110, inFlight: 1 },
      firstDenial: { t: 60, spent: 110, held: 60 },
      decisions: [{ ms: 42, allowed: false }],
      series: [
        { t: 0, spent: 0, held: 0 },
        { t: 10, spent: 0, held: 60 },
        { t: 20, spent: 0, held: 120 },
        { t: 30, spent: 70, held: 60 },
        { t: 40, spent: 70, held: 120 },
        { t: 50, spent: 110, held: 60 },
      ],
      stoppedAgents: 1,
      done: false,
    })
  })
})

describe("the after-the-fact cap", () => {
  it("overshoots with 50 runaway agents because calls in flight land past the cap", async () => {
    let state: PanelState = initialPanel(CAP, 50)
    await runPanel({
      gate: afterTheFactGate(CAP),
      seed: SEED,
      agents: 50,
      variance: "med",
      sleep,
      signal: new AbortController().signal,
      emit: (event) => {
        state = panelReducer(state, event)
      },
    })
    expect(state.done).toBe(true)
    expect(state.inFlight).toBe(0)
    expect(state.spent).toBeGreaterThan(CAP)
    expect(state.alert?.inFlight).toBeGreaterThan(0)
  })
})
