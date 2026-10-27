import { type PanelState, initialPanel, panelReducer } from "../src/shared/engine"
import { micros, toUsd } from "../src/shared/money"
import { type Mode, type RunRequest, readRunEvents } from "../src/shared/run"

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"
const CAP = micros(5_000_000)
const SEED = 7
const SIZES = [5, 10, 25, 50] as const
const MODES: readonly Mode[] = ["remote", "local"]
const BURST = 25

const postRun = (body: unknown) =>
  fetch(`${BASE_URL}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

async function runOnce(mode: Mode, agents: number) {
  const request: RunRequest = { budget: CAP / 1e6, agents, variance: "med", seed: SEED, mode }
  const response = await postRun(request)
  if (!response.ok || !response.body) throw new Error(`POST /api/runs answered ${response.status}: ${await response.text()}`)

  const panels = { left: initialPanel(CAP, agents), right: initialPanel(CAP, agents) }
  let ended = false
  for await (const event of readRunEvents(response.body)) {
    if ("panel" in event) panels[event.panel] = panelReducer(panels[event.panel], event)
    else if (event.type === "ready") continue
    else if (event.type === "error") throw new Error(`${mode} run with ${agents} agents failed: ${event.message}`)
    else ended = true
  }
  if (!ended) throw new Error(`${mode} run with ${agents} agents closed without an end event`)
  return { mode, agents, ...panels }
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

const times = (state: PanelState, allowed: boolean) => state.decisions.filter((d) => d.allowed === allowed).map((d) => d.ms)

const results: { mode: Mode; agents: number; left: PanelState; right: PanelState }[] = []
for (const mode of MODES) for (const agents of SIZES) results.push(await runOnce(mode, agents))

console.table(
  results.map(({ mode, agents, left, right }) => ({
    mode,
    N: agents,
    "left final": toUsd(left.spent),
    "left overshoot": toUsd(micros(Math.max(0, left.spent - CAP))),
    "right final": toUsd(right.spent),
    "right peak reserved": toUsd(micros(Math.max(...right.series.map((p) => p.spent + p.held)))),
    "right denials": right.denied,
    "allowed p50 ms": percentile(times(right, true), 0.5).toFixed(1),
    "allowed p95 ms": percentile(times(right, true), 0.95).toFixed(1),
    "denied p50 ms": percentile(times(right, false), 0.5).toFixed(1),
  })),
)

// An empty body is rejected after the limiter counts it, so the burst starts no runs against the hosted API.
const burst = await Promise.all(Array.from({ length: BURST }, () => postRun({})))
const passed = burst.filter((r) => r.status === 400).length
const limited = burst.filter((r) => r.status === 429).length
console.log(`burst of ${BURST} POST /api/runs: ${passed} passed the limiter, ${limited} rate limited (429)`)

const overshoot = (agents: number) => results.find((r) => r.mode === "remote" && r.agents === agents)!.left.spent - CAP
const median = (mode: Mode) => percentile(results.filter((r) => r.mode === mode).flatMap((r) => times(r.right, true)), 0.5)
const checks: [string, boolean][] = [
  ["right final spend <= cap for every N and mode", results.every((r) => r.right.spent <= CAP)],
  ["right spent + held <= cap at every point for every N and mode", results.every((r) => r.right.series.every((p) => p.spent + p.held <= CAP))],
  // The largest med estimate is 40k input tokens at $3/M plus 4,096 output tokens at $15/M.
  ["right ends within one worst-case call of the cap in both modes", results.every((r) => r.right.spent >= CAP - (40_000 * 3 + 4096 * 15))],
  ["a reserve that runs answers faster locally than remotely (median)", median("local") < median("remote")],
  ["left overshoots the cap at N=10", overshoot(10) > 0],
  ["left overshoot grows from N=10 to N=25 to N=50", overshoot(10) < overshoot(25) && overshoot(25) < overshoot(50)],
  ["a burst past the run limit gets 429", limited > 0],
]
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
