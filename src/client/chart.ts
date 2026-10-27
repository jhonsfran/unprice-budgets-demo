import type { PanelState, SeriesPoint } from "../shared/engine"

export type ChartKind = "after" | "reserve"

/** Both panels draw on one scale so their overshoot compares by eye. */
export type ChartScale = { tMax: number; yMax: number }

type Palette = Record<"surface" | "muted" | "grid" | "axis" | "spent" | "reserved" | "critical", string>

let palette: Palette | null = null

function tokens(): Palette {
  if (palette) return palette
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(`--${name}`).trim()
  palette = {
    surface: read("surface"),
    muted: read("muted"),
    grid: read("grid"),
    axis: read("axis"),
    spent: read("spent"),
    reserved: read("reserved"),
    critical: read("critical"),
  }
  return palette
}

const PAD = { left: 44, right: 12, top: 14, bottom: 24 }

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
  const x = (t: number) => PAD.left + (Math.min(t, scale.tMax) / scale.tMax) * plotW
  const y = (micros: number) => PAD.top + plotH - (micros / scale.yMax) * plotH
  const crisp = (v: number) => Math.round(v) + 0.5

  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif"
  ctx.lineWidth = 1

  const dollarStep = niceStep(scale.yMax / 1e6, 4, DOLLAR_STEPS)
  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  for (let dollars = 0; dollars * 1e6 <= scale.yMax; dollars += dollarStep) {
    const py = crisp(y(dollars * 1e6))
    ctx.strokeStyle = dollars === 0 ? colors.axis : colors.grid
    ctx.beginPath()
    ctx.moveTo(PAD.left, py)
    ctx.lineTo(PAD.left + plotW, py)
    ctx.stroke()
    ctx.fillStyle = colors.muted
    ctx.fillText(`$${dollars % 1 === 0 ? dollars : dollars.toFixed(1)}`, PAD.left - 8, py)
  }

  const secondStep = niceStep(scale.tMax / 1000, 5, SECOND_STEPS)
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  for (let s = 0; s * 1000 <= scale.tMax; s += secondStep) {
    ctx.fillStyle = colors.muted
    ctx.fillText(`${s}s`, x(s * 1000), PAD.top + plotH + 8)
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
  const capY = y(state.cap)

  if (kind === "after") {
    const area = stepPath((p) => p.spent)
    area.lineTo(x(endT), y(0))
    area.lineTo(x(series[0]!.t), y(0))
    area.closePath()
    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.left, PAD.top - 2, plotW, capY - PAD.top + 2)
    ctx.clip()
    ctx.globalAlpha = 0.3
    ctx.fillStyle = colors.critical
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
    ctx.globalAlpha = 0.14
    ctx.fillStyle = colors.reserved
    ctx.fill(band)
    ctx.globalAlpha = 1
  }

  ctx.setLineDash([4, 4])
  ctx.strokeStyle = colors.muted
  ctx.beginPath()
  ctx.moveTo(PAD.left, crisp(capY))
  ctx.lineTo(PAD.left + plotW, crisp(capY))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = colors.muted
  ctx.textAlign = "left"
  ctx.textBaseline = "bottom"
  ctx.fillText("cap", PAD.left + 6, capY - 3)

  ctx.lineWidth = 2
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  if (kind === "reserve") {
    ctx.strokeStyle = colors.reserved
    ctx.stroke(stepPath(reserved))
  }
  ctx.strokeStyle = colors.spent
  ctx.stroke(spentLine)

  const dot = (t: number, micros: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(x(t), y(micros), 4, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = colors.surface
    ctx.stroke()
  }

  const last = series[series.length - 1]!
  dot(endT, last.spent, colors.spent)

  if (hoverT !== null) {
    const at = valueAt(series, hoverT)
    ctx.lineWidth = 1
    ctx.strokeStyle = colors.axis
    ctx.beginPath()
    ctx.moveTo(crisp(x(hoverT)), PAD.top)
    ctx.lineTo(crisp(x(hoverT)), PAD.top + plotH)
    ctx.stroke()
    if (kind === "reserve") dot(hoverT, reserved(at), colors.reserved)
    dot(hoverT, at.spent, colors.spent)
  }
}

export function timeAtPointer(canvas: HTMLCanvasElement, clientX: number, scale: ChartScale): number | null {
  const rect = canvas.getBoundingClientRect()
  const plotW = rect.width - PAD.left - PAD.right
  const offset = clientX - rect.left - PAD.left
  if (offset < 0 || offset > plotW) return null
  return (offset / plotW) * scale.tMax
}
