import { errorResponse } from "./api"

export { BudgetRun } from "./budget-run"

const BEARER = /^Bearer (run_[0-9a-f-]{36})$/

async function createRun(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local"
  const { success } = await env.RUNS_LIMITER.limit({ key: ip })
  if (!success) {
    return Response.json(
      { error: "rate_limited", message: "Too many runs from your address. Try again in a minute." },
      { status: 429 },
    )
  }
  const token = `run_${crypto.randomUUID()}`
  await env.BUDGET_RUN.getByName(token).open()
  return Response.json({ token })
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/api/runs" && req.method === "POST") return createRun(req, env)

    if (url.pathname.startsWith("/unprice/")) {
      const token = req.headers.get("Authorization")?.match(BEARER)?.[1]
      if (!token) return errorResponse("UNAUTHORIZED", "Send the run token from POST /api/runs as a Bearer token")
      url.pathname = url.pathname.slice("/unprice".length)
      return env.BUDGET_RUN.getByName(token).fetch(new Request(url, req))
    }

    return Response.json({ error: "not_found" }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
