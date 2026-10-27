import { Unprice } from "@unprice/budgets"
import { type Gate, type PanelState, initialPanel, panelReducer, runPanel } from "../src/shared/engine"
import { afterTheFactGate, unpriceGate } from "../src/shared/gates"
import { micros, toDecimal, toUsd } from "../src/shared/money"

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"
const CAP = micros(5_000_000)
const SEED = 7
const SIZES = [5, 10, 25, 50] as const
const BURST = 25

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function createRun(): Promise<Response> {
  return fetch(`${BASE_URL}/api/runs`, { method: "POST" })
}

async function runOnce(agents: number) {
  const response = await createRun()
  if (!response.ok) throw new Error(`POST /api/runs answered ${response.status}: ${await response.text()}`)
  const body: unknown = await response.json()
  const token = typeof body === "object" && body !== null && "token" in body ? body.token : undefined
  if (typeof token !== "string") throw new Error(`POST /api/runs returned no token: ${JSON.stringify(body)}`)

  const unprice = new Unprice({ token, baseUrl: `${BASE_URL}/unprice`, disableTelemetry: true })
  const key = `run:${token}`
  const upserted = await unprice.budgets.upsert({ key, unit: "USD", limits: [{ amount: toDecimal(CAP), window: "never" }] })
  if (upserted.error) throw new Error(`upsert failed: ${upserted.error.message}`)

  const panel = async (gate: Gate): Promise<PanelState> => {
    let state = initialPanel(CAP, agents)
    await runPanel({
      gate,
      seed: SEED,
      agents,
      variance: "med",
      sleep,
      signal: new AbortController().signal,
      emit: (event) => {
        state = panelReducer(state, event)
      },
    })
    return state
  }
  const [left, right] = await Promise.all([panel(afterTheFactGate(CAP)), panel(unpriceGate(unprice.budget(key), sleep))])
  return { agents, left, right }
}

const results: Awaited<ReturnType<typeof runOnce>>[] = []
for (const agents of SIZES) results.push(await runOnce(agents))

console.table(
  results.map(({ agents, left, right }) => ({
    N: agents,
    "left final": toUsd(left.spent),
    "left overshoot": toUsd(micros(Math.max(0, left.spent - CAP))),
    "right final": toUsd(right.spent),
    "right peak reserved": toUsd(micros(Math.max(...right.series.map((p) => p.spent + p.held)))),
    "right denials (402)": right.denied,
  })),
)

const burst = await Promise.all(Array.from({ length: BURST }, () => createRun()))
const accepted = burst.filter((r) => r.status === 200).length
const limited = burst.filter((r) => r.status === 429).length
console.log(`burst of ${BURST} POST /api/runs: ${accepted} accepted, ${limited} rate limited (429)`)

const overshoot = (agents: number) => {
  const found = results.find((r) => r.agents === agents)!
  return found.left.spent - CAP
}
const checks: [string, boolean][] = [
  ["right final spend <= cap for every N", results.every((r) => r.right.spent <= CAP)],
  ["right spent + held <= cap at every point for every N", results.every((r) => r.right.series.every((p) => p.spent + p.held <= CAP))],
  ["left overshoots the cap at N=10", overshoot(10) > 0],
  ["left overshoot grows from N=10 to N=25 to N=50", overshoot(10) < overshoot(25) && overshoot(25) < overshoot(50)],
  ["a burst past the run limit gets 429", limited > 0],
]
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`)
process.exit(checks.every(([, passed]) => passed) ? 0 : 1)
