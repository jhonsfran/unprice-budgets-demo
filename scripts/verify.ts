import { type PanelState, initialPanel, panelReducer } from "../src/shared/engine"
import { micros, toUsd } from "../src/shared/money"
import { type RunRequest, readRunEvents } from "../src/shared/run"

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"
const CAP = micros(5_000_000)
const SEED = 7
const SIZES = [5, 10, 25, 50] as const
const BURST = 25

const postRun = (body: unknown) =>
  fetch(`${BASE_URL}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

async function runOnce(agents: number) {
  const request: RunRequest = { budget: CAP / 1e6, agents, variance: "med", seed: SEED }
  const response = await postRun(request)
  if (!response.ok || !response.body) throw new Error(`POST /api/runs answered ${response.status}: ${await response.text()}`)

  const panels = { left: initialPanel(CAP, agents), right: initialPanel(CAP, agents) }
  let ended = false
  for await (const event of readRunEvents(response.body)) {
    if ("panel" in event) panels[event.panel] = panelReducer(panels[event.panel], event)
    else if (event.type === "error") throw new Error(`run with ${agents} agents failed: ${event.message}`)
    else ended = true
  }
  if (!ended) throw new Error(`run with ${agents} agents closed without an end event`)
  return { agents, ...panels }
}

const results: { agents: number; left: PanelState; right: PanelState }[] = []
for (const agents of SIZES) results.push(await runOnce(agents))

console.table(
  results.map(({ agents, left, right }) => ({
    N: agents,
    "left final": toUsd(left.spent),
    "left overshoot": toUsd(micros(Math.max(0, left.spent - CAP))),
    "right final": toUsd(right.spent),
    "right peak reserved": toUsd(micros(Math.max(...right.series.map((p) => p.spent + p.held)))),
    "right denials (402)": right.denied,
    // Each call is one authorize and one settle; each 402 is one more authorize. SDK retries are not counted.
    "right API requests": right.calls * 2 + right.denied,
  })),
)

// An empty body is rejected after the limiter counts it, so the burst starts no runs against the hosted API.
const burst = await Promise.all(Array.from({ length: BURST }, () => postRun({})))
const passed = burst.filter((r) => r.status === 400).length
const limited = burst.filter((r) => r.status === 429).length
console.log(`burst of ${BURST} POST /api/runs: ${passed} passed the limiter, ${limited} rate limited (429)`)

const overshoot = (agents: number) => results.find((r) => r.agents === agents)!.left.spent - CAP
const checks: [string, boolean][] = [
  ["right final spend <= cap for every N", results.every((r) => r.right.spent <= CAP)],
  ["right spent + held <= cap at every point for every N", results.every((r) => r.right.series.every((p) => p.spent + p.held <= CAP))],
  ["left overshoots the cap at N=10", overshoot(10) > 0],
  ["left overshoot grows from N=10 to N=25 to N=50", overshoot(10) < overshoot(25) && overshoot(25) < overshoot(50)],
  ["a burst past the run limit gets 429", limited > 0],
]
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
