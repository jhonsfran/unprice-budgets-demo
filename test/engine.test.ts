import { Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { type Gate, type PanelState, initialPanel, panelReducer, runPanel } from "../src/shared/engine"
import { afterTheFactGate, unpriceGate } from "../src/shared/gates"
import { micros, toDecimal } from "../src/shared/money"
import { callSpec } from "../src/shared/sim"
import { createBudgetApi } from "../src/worker/api"

const CAP = micros(5_000_000)
const SEED = 20261027
const AGENTS = 50
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / 50))

async function run(gate: Gate): Promise<PanelState> {
  let state = initialPanel(CAP, AGENTS)
  await runPanel({
    gate,
    seed: SEED,
    agents: AGENTS,
    variance: "med",
    sleep,
    signal: new AbortController().signal,
    emit: (event) => {
      state = panelReducer(state, event)
    },
  })
  return state
}

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

describe("the same runaway agents under both caps", () => {
  it("overshoots when checking after the call and never passes the cap when reserving before it", async () => {
    const unprice = new Unprice({ token: "test", fetch: createBudgetApi(), baseUrl: "http://local", disableTelemetry: true })
    const key = "run:engine-test"
    const upserted = await unprice.budgets.upsert({ key, unit: "USD", limits: [{ amount: toDecimal(CAP), window: "never" }] })
    expect(upserted.error).toBeUndefined()

    const [left, right] = await Promise.all([run(afterTheFactGate(CAP)), run(unpriceGate(unprice.budget(key), sleep))])

    expect(left.done).toBe(true)
    expect(left.spent).toBeGreaterThan(CAP)
    expect(left.alert?.inFlight).toBeGreaterThan(0)

    expect(right.done).toBe(true)
    expect(right.spent).toBeLessThanOrEqual(CAP)
    expect(right.series.filter((p) => p.spent + p.held > CAP)).toEqual([])
    expect(right.denied).toBeGreaterThan(0)
    expect(right.inFlight).toBe(0)

    const maxEstimate = Math.max(
      ...Array.from({ length: AGENTS }, (_, agent) =>
        Array.from({ length: 50 }, (_, index) => callSpec(SEED, agent, index, "med").estimate),
      ).flat(),
    )
    expect(right.spent).toBeGreaterThanOrEqual(CAP - maxEstimate)

    const balance = await unprice.budget(key).authorize({ amount: "0", idempotencyKey: "probe" })
    expect(balance.result?.balance?.limits[0]?.consumed).toBe(toDecimal(right.spent).replace(/\.?0+$/, ""))
  })
})
