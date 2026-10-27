import { DurableObject } from "cloudflare:workers"
import { createBudgetApi, errorResponse } from "./api"

const RUN_TTL_MS = 5 * 60_000
const MAX_REQUESTS = 20_000

/** One demo run's budgets, held in memory: a run never outlives its five minutes. */
export class BudgetRun extends DurableObject<Env> {
  private openedAt: number | null = null
  private requests = 0
  private readonly api = createBudgetApi()

  async open(): Promise<void> {
    this.openedAt ??= Date.now()
  }

  override async fetch(req: Request): Promise<Response> {
    if (this.openedAt === null || Date.now() - this.openedAt > RUN_TTL_MS) {
      return errorResponse("UNAUTHORIZED", "This run is unknown or has expired. Start a new run.")
    }
    this.requests += 1
    if (this.requests > MAX_REQUESTS) {
      return errorResponse("TOO_MANY_REQUESTS", `A run serves at most ${MAX_REQUESTS} requests`)
    }
    return this.api(req)
  }
}
