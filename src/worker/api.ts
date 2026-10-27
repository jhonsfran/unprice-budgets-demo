import type { BudgetBalance, ErrorResponse, OperationResponseOf, operations } from "@unprice/budgets"
import {
  type Balance,
  type Change,
  type HoldRejection,
  Ledger,
  MIN_HOLD_TTL_MS,
  type Units,
  formatUnits,
  parseUnits,
  units,
} from "./ledger"

type Ok<Op extends keyof operations> = OperationResponseOf<operations[Op]>
type ApiError = ErrorResponse["error"]
export type ErrorCode = ApiError["code"]
type Details = NonNullable<ApiError["details"]>

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  BUDGET_EXCEEDED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$/
const MAX_CAP = units(20n * 10n ** 8n)
const MAX_TTL_MS = 86_400_000
const DEFAULT_HOLDS = { defaultTtlMs: 900_000, maxTtlMs: MAX_TTL_MS }

export function errorResponse(code: ErrorCode, message: string, details?: Details): Response {
  const requestId = `req_${crypto.randomUUID()}`
  const error: ApiError = {
    code,
    message,
    docs: `https://docs.unprice.dev/api-reference/errors/code/${code}`,
    requestId,
    ...(details ? { details } : {}),
  }
  const body: { error: ApiError } = { error }
  return Response.json(body, { status: STATUS[code], headers: { "unprice-request-id": requestId } })
}

function ok<Op extends keyof operations>(body: Ok<Op>): Response {
  return Response.json(body, { headers: { "unprice-request-id": `req_${crypto.randomUUID()}` } })
}

class BadRequest extends Error {}

type Body = Record<string, unknown>

const isRecord = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function field<T>(body: Body, name: string, check: (value: unknown) => value is T, expected: string): T {
  const value = body[name]
  if (!check(value)) throw new BadRequest(`${name} must be ${expected}`)
  return value
}

const isString = (value: unknown): value is string => typeof value === "string"
const isAbsent = (value: unknown): value is undefined => value === undefined
const isList = (value: unknown): value is unknown[] => Array.isArray(value)
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
const isTtl = (value: unknown): value is number => isInteger(value) && value >= MIN_HOLD_TTL_MS && value <= MAX_TTL_MS

function budgetKey(body: Body): string {
  const key = field(body, "key", isString, "a string")
  if (!KEY.test(key)) throw new BadRequest("key must be up to 128 letters, digits, and : / _ . @ -, starting with a letter or digit")
  return key
}

function amount(body: Body, name: string): Units {
  const text = field(body, name, isString, "a decimal string")
  const parsed = parseUnits(text)
  if (parsed === null) throw new BadRequest(`${name} must be a non-negative decimal with at most 8 decimal places`)
  return parsed
}

function balanceBody(balance: Balance, now: number): BudgetBalance {
  const remaining = formatUnits(units(balance.cap - balance.consumed - balance.held))
  const held = formatUnits(balance.held)
  return {
    remaining,
    held,
    limits: [
      {
        id: balance.limitId,
        window: "never",
        enforce: "hard",
        amount: formatUnits(balance.cap),
        consumed: formatUnits(balance.consumed),
        held,
        remaining,
        resetsAt: null,
      },
    ],
    asOf: now,
  }
}

function changeBody(change: Change): Ok<"budgets.upsert">["changes"][number] {
  switch (change.change) {
    case "limit.added":
      return { change: change.change, limitId: change.limitId, to: formatUnits(change.to) }
    case "limit.amount":
      return { change: change.change, limitId: change.limitId, from: formatUnits(change.from), to: formatUnits(change.to) }
    case "holds":
      return { change: change.change }
  }
}

function holdRejection(rejection: HoldRejection, verb: "settle" | "release"): Response {
  switch (rejection.kind) {
    case "budget_not_found":
      return errorResponse("NOT_FOUND", "Budget not found")
    case "hold_not_found":
      return errorResponse("NOT_FOUND", `Hold ${rejection.holdId} not found`)
    case "hold_closed": {
      const message =
        rejection.status === "expired"
          ? `Hold ${rejection.holdId} expired and was settled at its full amount`
          : `Hold ${rejection.holdId} is already ${rejection.status}`
      if (verb === "settle") return errorResponse("CONFLICT", message)
      return errorResponse("CONFLICT", message, {
        kind: "release_rejected",
        rejection: { code: "HOLD_CLOSED", holdId: rejection.holdId, status: rejection.status },
      })
    }
  }
}

type Route = (body: Body, now: number) => Response

/**
 * The subset of the Unprice budgets HTTP API that `budget.spend` and `budgets.upsert` speak:
 * one USD budget per key with a single hard limit that never resets.
 */
export function createBudgetApi({ now = Date.now }: { now?: () => number } = {}): (req: Request) => Promise<Response> {
  const ledger = new Ledger()

  const routes: Record<string, Route> = {
    "/v1/budgets/upsert": (body, at) => {
      const key = budgetKey(body)
      if (field(body, "unit", isString, "a string") !== "USD") throw new BadRequest("unit must be USD in this demo")
      field(body, "closesAt", (v): v is null | undefined => v === null || v === undefined, "null in this demo")
      field(body, "onUnavailable", (v): v is "deny" | undefined => v === "deny" || v === undefined, '"deny"')

      const limits = field(body, "limits", isList, "an array")
      const [limit] = limits
      if (limits.length !== 1 || !isRecord(limit)) throw new BadRequest("limits must hold exactly one limit in this demo")
      if (field(limit, "window", isString, "a string") !== "never") throw new BadRequest('limits[0].window must be "never" in this demo')
      field(limit, "enforce", (v): v is "hard" | undefined => v === "hard" || v === undefined, '"hard" in this demo')
      field(limit, "anchor", isAbsent, "omitted for window never")
      const limitId = limit.id === undefined ? "never" : field(limit, "id", isString, "a string")
      const cap = amount(limit, "amount")
      if (cap <= 0n || cap > MAX_CAP) throw new BadRequest("limits[0].amount must be above 0 and at most 20 in this demo")

      const holdsInput = body.holds === undefined ? {} : field(body, "holds", isRecord, "an object")
      const holds = {
        defaultTtlMs: holdsInput.defaultTtlMs === undefined ? DEFAULT_HOLDS.defaultTtlMs : field(holdsInput, "defaultTtlMs", isTtl, "1000 to 86400000"),
        maxTtlMs: holdsInput.maxTtlMs === undefined ? DEFAULT_HOLDS.maxTtlMs : field(holdsInput, "maxTtlMs", isTtl, "1000 to 86400000"),
      }
      if (holds.defaultTtlMs > holds.maxTtlMs) throw new BadRequest("holds.defaultTtlMs must not exceed holds.maxTtlMs")

      const outcome = ledger.upsert(key, { limitId, cap, holds }, at)
      if (outcome.kind === "limit_below_usage") {
        return errorResponse("CONFLICT", `Limit ${outcome.limitId} cannot drop below current usage`, {
          kind: "limit_below_usage",
          limitId: outcome.limitId,
          minimum: formatUnits(outcome.minimum),
          requested: formatUnits(outcome.requested),
        })
      }
      const { budget } = outcome
      return ok<"budgets.upsert">({
        changes: outcome.changes.map(changeBody),
        budget: {
          key: budget.key,
          unit: "money:USD",
          version: budget.version,
          limits: [{ id: budget.definition.limitId, amount: formatUnits(budget.definition.cap), window: "never", enforce: "hard" }],
          holds: budget.definition.holds,
          onUnavailable: "deny",
          closesAt: null,
          closed: false,
          balance: balanceBody(budget.balance, at),
          operations: { ...budget.operations, charge: 0, record: 0, lease: 0, report: 0 },
        },
      })
    },

    "/v1/budgets/authorize": (body, at) => {
      const key = budgetKey(body)
      const requested = amount(body, "amount")
      const ttlMs = body.ttlMs === undefined ? null : field(body, "ttlMs", isInteger, "an integer")
      const idempotencyKey = field(body, "idempotencyKey", isString, "a string")
      if (idempotencyKey.length < 1 || idempotencyKey.length > 256) throw new BadRequest("idempotencyKey must be 1 to 256 characters")
      field(body, "ifMissing", isAbsent, "omitted in this demo; upsert the budget first")

      const outcome = ledger.authorize(key, { amount: requested, ttlMs, idempotencyKey }, at)
      switch (outcome.kind) {
        case "budget_not_found":
          return errorResponse("NOT_FOUND", `Budget ${key} not found`)
        case "idempotency_conflict":
          return errorResponse("CONFLICT", `Idempotency key ${idempotencyKey} was used with a different request`)
        case "invalid_ttl":
          return errorResponse("BAD_REQUEST", `Hold TTL must be between ${MIN_HOLD_TTL_MS} and ${outcome.maxTtlMs} ms, got ${outcome.ttlMs}`)
        case "exceeded": {
          const balance = balanceBody(outcome.balance, at)
          return errorResponse("BUDGET_EXCEEDED", `Budget ${key} cannot cover ${formatUnits(requested)}`, {
            kind: "budget_exceeded",
            blocked: {
              limitId: outcome.balance.limitId,
              window: "never",
              remaining: formatUnits(outcome.remaining),
              held: formatUnits(outcome.held),
              resetsAt: null,
              remedy: outcome.remedy,
            },
            balance,
          })
        }
        case "ok":
          return ok<"budgets.authorize">({
            allowed: true,
            holdId: outcome.hold.id,
            amount: formatUnits(outcome.hold.amount),
            expiresAt: outcome.hold.expiresAt,
            replayed: outcome.replayed,
            balance: balanceBody(outcome.balance, at),
            created: false,
          })
      }
    },

    "/v1/budgets/settle": (body, at) => {
      const key = budgetKey(body)
      const holdId = field(body, "holdId", isString, "a string")
      const actual = amount(body, "amount")
      const outcome = ledger.settle(key, holdId, actual, at)
      switch (outcome.kind) {
        case "hold_amount_exceeded":
          return errorResponse("CONFLICT", `Hold ${holdId} permits ${formatUnits(outcome.maximum)}, not ${formatUnits(outcome.actual)}`, {
            kind: "hold_amount_exceeded",
            holdId,
            maximum: formatUnits(outcome.maximum),
            actual: formatUnits(outcome.actual),
          })
        case "ok":
          return ok<"budgets.settle">({
            holdId,
            actual: formatUnits(outcome.actual),
            released: formatUnits(outcome.released),
            expired: outcome.expired,
            crossed: [],
            replayed: outcome.replayed,
            balance: balanceBody(outcome.balance, at),
          })
        default:
          return holdRejection(outcome, "settle")
      }
    },

    "/v1/budgets/release": (body, at) => {
      const key = budgetKey(body)
      const holdId = field(body, "holdId", isString, "a string")
      const outcome = ledger.release(key, holdId, at)
      if (outcome.kind !== "ok") return holdRejection(outcome, "release")
      return ok<"budgets.release">({
        holdId,
        released: formatUnits(outcome.released),
        replayed: outcome.replayed,
        balance: balanceBody(outcome.balance, at),
      })
    },
  }

  return async (req) => {
    const route = req.method === "POST" ? routes[new URL(req.url).pathname] : undefined
    if (!route) return errorResponse("NOT_FOUND", `${req.method} ${new URL(req.url).pathname} is not a route of this API`)
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return errorResponse("BAD_REQUEST", "The request body must be JSON")
    }
    if (!isRecord(body)) return errorResponse("BAD_REQUEST", "The request body must be a JSON object")
    try {
      return route(body, now())
    } catch (error) {
      if (error instanceof BadRequest) return errorResponse("BAD_REQUEST", error.message)
      throw error
    }
  }
}
