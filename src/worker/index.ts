import { Unprice } from "@unprice/budgets"
import { type Gate, type Sleep, runPanel } from "../shared/engine"
import { afterTheFactGate, unpriceGate } from "../shared/gates"
import { micros } from "../shared/money"
import type { RunEvent, RunRequest, Side } from "../shared/run"

const RUN_CEILING_MS = 90_000

const isIntIn = (n: unknown, min: number, max: number): n is number =>
  Number.isInteger(n) && (n as number) >= min && (n as number) <= max

function parseRunRequest(body: unknown): RunRequest | null {
  if (typeof body !== "object" || body === null) return null
  const { budget, agents, variance, seed } = body as Record<string, unknown>
  if (typeof budget !== "number" || !isIntIn(budget * 2, 2, 40)) return null
  if (!isIntIn(agents, 1, 50) || !isIntIn(seed, 0, 0xffff_ffff)) return null
  if (variance !== "low" && variance !== "med" && variance !== "high") return null
  return { budget, agents, variance, seed }
}

function abortableSleep(signal: AbortSignal): Sleep {
  return (ms) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const id = setTimeout(resolve, ms)
      signal.addEventListener("abort", () => (clearTimeout(id), resolve()), { once: true })
    })
}

/** Runs both panels on one clock and seed, streaming each event as a line of NDJSON. */
function streamRun(run: RunRequest, env: Env, clientGone: AbortSignal): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const stop = new AbortController()
  const signal = AbortSignal.any([clientGone, stop.signal, AbortSignal.timeout(RUN_CEILING_MS)])

  let open = true
  const send = (event: RunEvent) => {
    if (open) writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => stop.abort())
  }
  // A failed panel can still have agents running; nothing they emit may follow the last line.
  const finish = (last: RunEvent) => {
    send(last)
    open = false
    writer.close().catch(() => {})
  }

  const sleep = abortableSleep(signal)
  const panel = (side: Side, gate: Gate) =>
    runPanel({ ...run, gate, sleep, signal, emit: (event) => send({ panel: side, ...event }) })
  // Async so a missing token fails the right panel, not the request, and the left still runs.
  const right = async () => {
    const budget = new Unprice({ token: env.UNPRICE_TOKEN }).budget(`demo:run:${crypto.randomUUID()}`, {
      ifMissing: {
        unit: "USD",
        limits: [{ amount: String(run.budget), window: "never" }],
        closesAt: Date.now() + 10 * 60_000,
      },
    })
    await panel("right", unpriceGate(budget, sleep))
  }

  const panels = [panel("left", afterTheFactGate(micros(run.budget * 1e6))), right()]
  void Promise.allSettled(panels).then((outcomes) => {
    const failed = outcomes.find((outcome) => outcome.status === "rejected")
    if (!failed) return finish({ type: "end" })
    const message = failed.reason instanceof Error ? failed.reason.message : "The run failed."
    finish({ type: "error", message })
  })

  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } })
}

async function createRun(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local"
  const { success } = await env.RUNS_LIMITER.limit({ key: ip })
  if (!success) {
    return Response.json(
      { error: "rate_limited", message: "Too many runs from your address. Try again in a minute." },
      { status: 429 },
    )
  }
  const run = parseRunRequest(await req.json().catch(() => null))
  if (!run) {
    return Response.json(
      {
        error: "bad_request",
        message: "Send { budget: 1-20 in 0.5 steps, agents: 1-50, variance: low | med | high, seed: uint32 }.",
      },
      { status: 400 },
    )
  }
  return streamRun(run, env, req.signal)
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/api/runs" && req.method === "POST") return createRun(req, env)
    return Response.json({ error: "not_found" }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
