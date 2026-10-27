import { type PanelState, initialPanel, panelReducer } from "../shared/engine"
import { type Micros, micros, toUsd } from "../shared/money"
import { type RunEvent, type RunRequest, readRunEvents } from "../shared/run"
import type { Variance } from "../shared/sim"
import { type ChartKind, type ChartScale, drawChart, timeAtPointer, valueAt } from "./chart"

type Settings = { cap: Micros; agents: number; variance: Variance }

type Run = Settings & {
  seed: number
  startedAt: number
  left: PanelState
  right: PanelState
  controller: AbortController
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; settings: Settings }
  | { kind: "running"; run: Run }
  | { kind: "finished"; run: Run; endedAt: number; stopped: boolean }
  | { kind: "failed"; run: Run | null; message: string }

let phase: Phase = { kind: "idle" }
let hoverT: number | null = null

const $ = <T extends Element>(selector: string, root: ParentNode = document): T => {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  return element
}

const controls = {
  budget: $<HTMLInputElement>("#budget"),
  budgetOut: $<HTMLOutputElement>("#budget-out"),
  agents: $<HTMLInputElement>("#agents"),
  agentsOut: $<HTMLOutputElement>("#agents-out"),
  variance: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="variance"]')),
  run: $<HTMLButtonElement>("#run"),
  seed: $<HTMLSpanElement>("#seed"),
  notice: $<HTMLParagraphElement>("#notice"),
}

type PanelView = {
  kind: ChartKind
  amount: HTMLElement
  of: HTMLElement
  delta: HTMLElement
  canvas: HTMLCanvasElement
  tooltip: HTMLElement
  log: HTMLOListElement
}

function panelView(name: "left" | "right", kind: ChartKind): PanelView {
  const root = $<HTMLElement>(`[data-panel="${name}"]`)
  return {
    kind,
    amount: $("[data-amount]", root),
    of: $("[data-of]", root),
    delta: $("[data-delta]", root),
    canvas: $("[data-canvas]", root),
    tooltip: $("[data-tooltip]", root),
    log: $("[data-log]", root),
  }
}

const views = { left: panelView("left", "after"), right: panelView("right", "reserve") }

function readSettings(): Settings {
  const checked = controls.variance.find((input) => input.checked)?.value
  const variance: Variance = checked === "low" || checked === "high" ? checked : "med"
  return { cap: micros(Math.round(Number(controls.budget.value) * 1e6)), agents: Number(controls.agents.value), variance }
}

const seconds = (t: number) => `${(t / 1000).toFixed(1)}s`

type LogLine = { t: number | null; text: string; over?: boolean }

function leftLog(state: PanelState, finished: boolean): LogLine[] {
  const lines: LogLine[] = []
  if (finished) {
    const over = state.spent - state.cap
    lines.push(
      over > 0
        ? {
            t: null,
            text: `spent ${toUsd(state.spent)}, ${toUsd(micros(over))} over cap (+${Math.round((over / state.cap) * 100)}%)`,
            over: true,
          }
        : { t: null, text: `spent ${toUsd(state.spent)}, under the cap` },
    )
  }
  if (state.alert) {
    const { t, spent, inFlight } = state.alert
    lines.push({ t, text: `alert fired at ${toUsd(spent)}, ${inFlight} ${inFlight === 1 ? "call" : "calls"} in flight` })
  }
  return lines
}

function rightLog(state: PanelState, finished: boolean): LogLine[] {
  const lines: LogLine[] = []
  if (finished) {
    const over = state.spent > state.cap
    lines.push({ t: null, text: `spent ${toUsd(state.spent)}, ${over ? "over cap" : "never over cap"}`, over })
  }
  if (state.denied > 0) lines.push({ t: null, text: `${state.denied} ${state.denied === 1 ? "call" : "calls"} denied (402)` })
  if (state.firstDenial) {
    const { t, spent, held } = state.firstDenial
    lines.push({ t, text: `first 402 at ${toUsd(spent)} spent, ${toUsd(held)} reserved` })
  }
  return lines
}

function renderLog(list: HTMLOListElement, lines: LogLine[]): void {
  const items = lines.map(({ t, text, over }) => {
    const item = document.createElement("li")
    if (t !== null) {
      const time = document.createElement("time")
      time.textContent = seconds(t)
      item.append(time)
    }
    item.append(text)
    if (over) item.className = "over"
    return item
  })
  list.replaceChildren(...items)
}

function renderCounter(view: PanelView, state: PanelState): void {
  view.amount.textContent = toUsd(state.spent)
  view.of.textContent = `of ${toUsd(state.cap)} cap`
  const over = state.spent - state.cap
  if (over > 0) {
    view.delta.textContent = `+${toUsd(micros(over))} over`
    view.delta.dataset.tone = "over"
  } else {
    view.delta.textContent = `${toUsd(micros(-over))} under`
    view.delta.dataset.tone = view.kind === "reserve" ? "under" : ""
  }
}

function renderTooltip(view: PanelView, state: PanelState, scale: ChartScale): void {
  if (hoverT === null) {
    view.tooltip.hidden = true
    return
  }
  const at = valueAt(state.series, hoverT)
  const row = (keyColor: string, label: string, value: Micros) => {
    const line = document.createElement("div")
    line.className = "row"
    const key = document.createElement("span")
    key.className = `key ${keyColor}`
    const strong = document.createElement("strong")
    strong.textContent = toUsd(value)
    line.append(key, strong, ` ${label}`)
    return line
  }
  const time = document.createElement("div")
  time.textContent = seconds(hoverT)
  const rows = [time, row("key-spent", view.kind === "after" ? "recorded" : "settled", at.spent)]
  if (view.kind === "reserve") rows.push(row("key-reserved", "reserved", micros(at.spent + at.held)))
  view.tooltip.replaceChildren(...rows)
  view.tooltip.hidden = false
  const ratio = hoverT / scale.tMax
  view.tooltip.style.left = ratio > 0.6 ? "" : `${56 + ratio * (view.canvas.clientWidth - 56)}px`
  view.tooltip.style.right = ratio > 0.6 ? `${(1 - ratio) * (view.canvas.clientWidth - 56) + 20}px` : ""
}

function emptyRun(settings: Settings): Pick<Run, "left" | "right"> {
  return { left: initialPanel(settings.cap, settings.agents), right: initialPanel(settings.cap, settings.agents) }
}

function render(): void {
  const settings = readSettings()
  controls.budgetOut.textContent = toUsd(settings.cap)
  controls.agentsOut.textContent = String(settings.agents)

  const busy = phase.kind === "running" || phase.kind === "starting"
  for (const input of [controls.budget, controls.agents, ...controls.variance]) input.disabled = busy
  controls.run.textContent = phase.kind === "starting" ? "Starting" : busy ? "Stop" : phase.kind === "idle" || (phase.kind === "failed" && !phase.run) ? "Run" : "Run again"
  controls.run.dataset.mode = busy ? "stop" : "run"

  const run = "run" in phase ? phase.run : null
  controls.seed.textContent = run ? `seed ${run.seed}` : ""
  controls.notice.hidden = phase.kind !== "failed"
  if (phase.kind === "failed") controls.notice.textContent = phase.message

  const panels = run ?? emptyRun(settings)
  const now = performance.now()
  const endT =
    phase.kind === "running"
      ? now - phase.run.startedAt
      : phase.kind === "finished"
        ? phase.endedAt - phase.run.startedAt
        : Math.max(panels.left.series.at(-1)!.t, panels.right.series.at(-1)!.t)
  const peak = (state: PanelState) => Math.max(...state.series.map((p) => p.spent + p.held))
  const scale: ChartScale = {
    tMax: Math.max(endT, 2000),
    yMax: Math.max(panels.left.cap * 1.25, peak(panels.left), peak(panels.right)),
  }
  if (hoverT !== null) hoverT = Math.min(hoverT, endT)

  const finished = phase.kind === "finished"
  const stopped = phase.kind === "finished" && phase.stopped
  for (const [view, state, log] of [
    [views.left, panels.left, leftLog],
    [views.right, panels.right, rightLog],
  ] as const) {
    renderCounter(view, state)
    drawChart(view.canvas, state, view.kind, scale, endT, hoverT)
    renderTooltip(view, state, scale)
    const lines = log(state, finished)
    if (stopped) lines.unshift({ t: null, text: "stopped before the agents finished" })
    renderLog(view.log, lines)
  }
}

let frame = 0
function scheduleRender(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    render()
    if (phase.kind === "running") scheduleRender()
  })
}

async function failureMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  const message = typeof body === "object" && body !== null && "message" in body ? body.message : undefined
  return typeof message === "string" ? message : `Could not start a run (HTTP ${response.status}).`
}

async function start(): Promise<void> {
  const settings = readSettings()
  const controller = new AbortController()
  const request: RunRequest = {
    budget: settings.cap / 1e6,
    agents: settings.agents,
    variance: settings.variance,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
  }
  phase = { kind: "starting", settings }
  render()

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: controller.signal,
  }).catch(() => null)
  if (!response?.ok || !response.body) {
    const message = response ? await failureMessage(response) : "Could not reach the demo server."
    phase = { kind: "failed", run: null, message }
    return render()
  }

  const run: Run = { ...settings, seed: request.seed, startedAt: performance.now(), ...emptyRun(settings), controller }
  phase = { kind: "running", run }
  scheduleRender()

  let last: RunEvent | null = null
  try {
    for await (const event of readRunEvents(response.body)) {
      if ("panel" in event) run[event.panel] = panelReducer(run[event.panel], event)
      else last = event
    }
  } catch {
    // Stop aborts the fetch, which rejects the read; anything else dropped the connection.
  }
  if (last?.type === "end" || controller.signal.aborted) {
    phase = { kind: "finished", run, endedAt: performance.now(), stopped: controller.signal.aborted }
  } else {
    phase = { kind: "failed", run, message: last?.message ?? "The connection to the demo server dropped." }
  }
  render()
}

controls.run.addEventListener("click", () => {
  if (phase.kind === "running") return phase.run.controller.abort()
  if (phase.kind === "starting") return
  void start()
})

for (const input of [controls.budget, controls.agents, ...controls.variance]) {
  input.addEventListener("input", () => {
    if (phase.kind !== "running") render()
  })
}

for (const view of Object.values(views)) {
  view.canvas.addEventListener("pointermove", (event) => {
    const run = "run" in phase ? phase.run : null
    const endT = phase.kind === "finished" ? phase.endedAt - phase.run.startedAt : run ? performance.now() - run.startedAt : 0
    hoverT = run ? timeAtPointer(view.canvas, event.clientX, { tMax: Math.max(endT, 2000), yMax: 1 }) : null
    if (phase.kind !== "running") render()
  })
  view.canvas.addEventListener("pointerleave", () => {
    hoverT = null
    if (phase.kind !== "running") render()
  })
}

window.addEventListener("resize", () => {
  if (phase.kind !== "running") render()
})

render()
