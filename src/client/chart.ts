import type { PanelState, SeriesPoint } from "../shared/engine"

export type ChartKind = "after" | "reserve"

/** Both panels draw on one scale so their overshoot compares by eye. */
export type ChartScale = { tMax: number; yMax: number }

type Palette = Record<"surface" | "ink" | "ink2" | "muted" | "rule" | "held" | "over" | "accent" | "mono", string>

let palette: Palette | null = null

function tokens(): Palette {
  if (palette) return palette
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(`--${name}`).trim()
  palette = {
    surface: read("color-paper-2"),
    ink: read("color-ink"),
    ink2: read("color-ink-2"),
    muted: read("color-muted"),
    rule: read("color-rule"),
    held: read("color-held"),
    over: read("color-over"),
    accent: read("color-accent"),
    mono: read("font-outlier"),
  }
  return palette
}

const PAD = { left: 48, right: 12, top: 18, bottom: 26 }

function niceStep(span: number, targetTicks: number, steps: readonly number[]): number {
  const raw = span / targetTicks
  return steps.find((step) => step >= raw) ?? steps[steps.length - 1]!
}

const DOLLAR_STEPS = [0.5, 1, 2, 2.5, 5, 10] as const
const SECOND_STEPS = [0.5, 1, 2, 5, 10, 20, 30, 60] as const

/** The last point at or before `t`: the series is a step function of time. */
export function valueAt(series: readonly SeriesPoint[], t: number): SeriesPoint {
  let found = series[0]!
  for (const point of series) {
    if (point.t > t) break
    found = point
  }
  return found
}

export function drawChart(
  canvas: HTMLCanvasElement,
  state: PanelState,
  kind: ChartKind,
  scale: ChartScale,
  endT: number,
  hoverT: number | null,
): void {
  const colors = tokens()
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const plotW = width - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const left = PAD.left
  const right = PAD.left + plotW
  const base = PAD.top + plotH
  const dollarStep = niceStep(scale.yMax / 1e6, 4, DOLLAR_STEPS)
  // Round the top up to a tick so an overshoot always reads against a labelled line.
  const yTop = Math.ceil(scale.yMax / (dollarStep * 1e6)) * dollarStep * 1e6
  const x = (t: number) => left + (Math.min(t, scale.tMax) / scale.tMax) * plotW
  const y = (micros: number) => base - (micros / yTop) * plotH
  const crisp = (v: number) => Math.round(v) + 0.5
  const capY = crisp(y(state.cap))

  ctx.font = `12px ${colors.mono}`
  ctx.lineWidth = 1

  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  for (let dollars = 0; dollars * 1e6 <= yTop; dollars += dollarStep) {
    const py = crisp(y(dollars * 1e6))
    if (dollars > 0) {
      ctx.strokeStyle = colors.rule
      ctx.beginPath()
      ctx.moveTo(left, py)
      ctx.lineTo(right, py)
      ctx.stroke()
    }
    ctx.fillStyle = colors.muted
    ctx.fillText(`$${dollars % 1 === 0 ? dollars : dollars.toFixed(1)}`, left - 12, py)
  }

  const secondStep = niceStep(scale.tMax / 1000, 5, SECOND_STEPS)
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  for (let s = 0; s * 1000 <= scale.tMax; s += secondStep) {
    ctx.fillStyle = colors.muted
    ctx.fillText(`${s}s`, x(s * 1000), base + 10)
  }

  const series = state.series
  const reserved = (p: SeriesPoint) => p.spent + p.held
  const stepPath = (value: (p: SeriesPoint) => number) => {
    const path = new Path2D()
    let previous = series[0]!
    path.moveTo(x(previous.t), y(value(previous)))
    for (const point of series) {
      path.lineTo(x(point.t), y(value(previous)))
      path.lineTo(x(point.t), y(value(point)))
      previous = point
    }
    path.lineTo(x(endT), y(value(previous)))
    return path
  }
  const spentLine = stepPath((p) => p.spent)
  const aboveCap = () => {
    ctx.beginPath()
    ctx.rect(left, 0, plotW, capY)
    ctx.clip()
  }
  const belowCap = () => {
    ctx.beginPath()
    ctx.rect(left, capY, plotW, height - capY)
    ctx.clip()
  }

  if (kind === "after") {
    const area = stepPath((p) => p.spent)
    area.lineTo(x(endT), y(0))
    area.lineTo(x(series[0]!.t), y(0))
    area.closePath()
    ctx.save()
    aboveCap()
    ctx.globalAlpha = 0.28
    ctx.fillStyle = colors.over
    ctx.fill(area)
    ctx.restore()
  } else {
    const band = stepPath(reserved)
    let previous = series[series.length - 1]!
    band.lineTo(x(endT), y(previous.spent))
    for (let i = series.length - 1; i >= 0; i--) {
      const point = series[i]!
      band.lineTo(x(previous.t), y(point.spent))
      band.lineTo(x(point.t), y(point.spent))
      previous = point
    }
    band.closePath()
    ctx.globalAlpha = 0.16
    ctx.fillStyle = colors.held
    ctx.fill(band)
    ctx.globalAlpha = 1
    ctx.lineWidth = 1.5
    ctx.strokeStyle = colors.held
    ctx.stroke(stepPath(reserved))
  }

  // The cradle from the Unprice mark: the budget is a bracket, the cap its mouth.
  // Where spend has passed the cap, the rim breaks open so the spill leaves through it.
  ctx.lineWidth = 1
  ctx.setLineDash([2, 4])
  ctx.strokeStyle = colors.muted
  ctx.beginPath()
  ctx.moveTo(left, capY)
  ctx.lineTo(right, capY)
  ctx.stroke()
  ctx.setLineDash([])

  const rim = plotW * 0.3
  const breach = series.find((p) => p.spent > state.cap)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, width, height)
  ctx.rect(left + rim, capY - 3, plotW - 2 * rim, 6)
  if (breach) ctx.rect(x(breach.t), capY - 3, right + 3 - x(breach.t), 6)
  ctx.clip("evenodd")
  ctx.lineWidth = 3
  ctx.lineJoin = "miter"
  ctx.lineCap = "butt"
  ctx.strokeStyle = colors.ink2
  ctx.beginPath()
  ctx.moveTo(left + rim, capY)
  ctx.lineTo(left + 1.5, capY)
  ctx.lineTo(left + 1.5, base)
  ctx.lineTo(right - 1.5, base)
  ctx.lineTo(right - 1.5, capY)
  ctx.lineTo(right - rim, capY)
  ctx.stroke()
  ctx.restore()

  ctx.fillStyle = colors.muted
  ctx.textAlign = "left"
  ctx.textBaseline = "bottom"
  ctx.fillText(`cap $${(state.cap / 1e6).toFixed(2)}`, left + 2, capY - 6)

  ctx.lineWidth = 2
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  ctx.save()
  belowCap()
  ctx.strokeStyle = colors.ink
  ctx.stroke(spentLine)
  ctx.restore()
  ctx.save()
  aboveCap()
  ctx.strokeStyle = colors.over
  ctx.stroke(spentLine)
  ctx.restore()

  const dot = (t: number, micros: number, fill: string, radius = 4) => {
    ctx.beginPath()
    ctx.arc(x(t), y(micros), radius, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = colors.surface
    ctx.stroke()
  }

  const last = series[series.length - 1]!
  dot(endT, last.spent, last.spent > state.cap ? colors.over : colors.accent, 5)

  if (hoverT !== null) {
    const at = valueAt(series, hoverT)
    ctx.lineWidth = 1
    ctx.strokeStyle = colors.muted
    ctx.beginPath()
    ctx.moveTo(crisp(x(hoverT)), PAD.top)
    ctx.lineTo(crisp(x(hoverT)), base)
    ctx.stroke()
    if (kind === "reserve") dot(hoverT, reserved(at), colors.held)
    dot(hoverT, at.spent, at.spent > state.cap ? colors.over : colors.ink)
  }
}

export function timeAtPointer(canvas: HTMLCanvasElement, clientX: number, scale: ChartScale): number | null {
  const rect = canvas.getBoundingClientRect()
  const plotW = rect.width - PAD.left - PAD.right
  const offset = clientX - rect.left - PAD.left
  if (offset < 0 || offset > plotW) return null
  return (offset / plotW) * scale.tMax
}
