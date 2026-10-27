export type Units = bigint & { readonly __brand: "Units" }

const SCALE = 8
const ONE = 10n ** BigInt(SCALE)
const DECIMAL = /^\d{1,19}(\.\d{1,8})?$/

export const units = (n: bigint): Units => n as Units

export function parseUnits(text: string): Units | null {
  if (!DECIMAL.test(text)) return null
  const [whole = "0", fraction = ""] = text.split(".")
  return units(BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, "0")))
}

export function formatUnits(value: Units): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const fraction = (abs % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "")
  return `${negative ? "-" : ""}${abs / ONE}${fraction ? `.${fraction}` : ""}`
}

const add = (a: Units, b: Units): Units => units(a + b)
const sub = (a: Units, b: Units): Units => units(a - b)
const ZERO = units(0n)

export type Remedy = "release_holds" | "raise_limit"
export type Verb = "upsert" | "authorize" | "settle" | "release"

export type HoldTerms = { defaultTtlMs: number; maxTtlMs: number }
export type Definition = { limitId: string; cap: Units; holds: HoldTerms }

type HoldState =
  | { status: "open" }
  | { status: "settled"; actual: Units; expired: boolean }
  | { status: "released" }

export type Hold = {
  readonly id: string
  readonly amount: Units
  readonly expiresAt: number
  state: HoldState
}

type Budget = {
  key: string
  definition: Definition
  version: number
  consumed: Units
  held: Units
  holdSeq: number
  holds: Map<string, Hold>
  open: Set<Hold>
  idempotency: Map<string, { amount: Units; ttlMs: number | null; hold: Hold }>
  operations: Record<Verb, number>
}

export type Balance = { cap: Units; consumed: Units; held: Units; limitId: string }

export type Change =
  | { change: "limit.added"; limitId: string; to: Units }
  | { change: "limit.amount"; limitId: string; from: Units; to: Units }
  | { change: "holds" }

export type BudgetView = {
  key: string
  definition: Definition
  version: number
  balance: Balance
  operations: Record<Verb, number>
}

export type UpsertOutcome =
  | { kind: "ok"; changes: Change[]; budget: BudgetView }
  | { kind: "limit_below_usage"; limitId: string; minimum: Units; requested: Units }

export type AuthorizeOutcome =
  | { kind: "ok"; hold: Hold; replayed: boolean; balance: Balance }
  | { kind: "budget_not_found" }
  | { kind: "idempotency_conflict" }
  | { kind: "invalid_ttl"; ttlMs: number; maxTtlMs: number }
  | { kind: "exceeded"; remedy: Remedy; remaining: Units; held: Units; balance: Balance }

export type HoldRejection =
  | { kind: "budget_not_found" }
  | { kind: "hold_not_found"; holdId: string }
  | { kind: "hold_closed"; holdId: string; status: "settled" | "released" | "expired" }

export type SettleOutcome =
  | { kind: "ok"; actual: Units; released: Units; expired: boolean; replayed: boolean; balance: Balance }
  | { kind: "hold_amount_exceeded"; holdId: string; maximum: Units; actual: Units }
  | HoldRejection

export type ReleaseOutcome =
  | { kind: "ok"; released: Units; replayed: boolean; balance: Balance }
  | HoldRejection

export const MIN_HOLD_TTL_MS = 1000

/**
 * One hard limit per budget, counted for the life of the budget. Holds that pass their
 * expiresAt while open settle at their full amount, because the work they covered may have run.
 */
export class Ledger {
  private readonly budgets = new Map<string, Budget>()

  upsert(key: string, definition: Definition, now: number): UpsertOutcome {
    const existing = this.budgets.get(key)
    if (!existing) {
      const budget: Budget = {
        key,
        definition,
        version: 1,
        consumed: ZERO,
        held: ZERO,
        holdSeq: 0,
        holds: new Map(),
        open: new Set(),
        idempotency: new Map(),
        operations: { upsert: 1, authorize: 0, settle: 0, release: 0 },
      }
      this.budgets.set(key, budget)
      const changes: Change[] = [{ change: "limit.added", limitId: definition.limitId, to: definition.cap }]
      return { kind: "ok", changes, budget: view(budget) }
    }

    expire(existing, now)
    const minimum = add(existing.consumed, existing.held)
    if (definition.cap < minimum) {
      return { kind: "limit_below_usage", limitId: definition.limitId, minimum, requested: definition.cap }
    }
    const before = existing.definition
    const changes: Change[] = []
    if (before.limitId !== definition.limitId) {
      changes.push({ change: "limit.added", limitId: definition.limitId, to: definition.cap })
    } else if (before.cap !== definition.cap) {
      changes.push({ change: "limit.amount", limitId: definition.limitId, from: before.cap, to: definition.cap })
    }
    if (before.holds.defaultTtlMs !== definition.holds.defaultTtlMs || before.holds.maxTtlMs !== definition.holds.maxTtlMs) {
      changes.push({ change: "holds" })
    }
    if (changes.length > 0) {
      existing.definition = definition
      existing.version += 1
      existing.operations.upsert += 1
    }
    return { kind: "ok", changes, budget: view(existing) }
  }

  authorize(
    key: string,
    input: { amount: Units; ttlMs: number | null; idempotencyKey: string },
    now: number,
  ): AuthorizeOutcome {
    const budget = this.budgets.get(key)
    if (!budget) return { kind: "budget_not_found" }
    expire(budget, now)

    const known = budget.idempotency.get(input.idempotencyKey)
    if (known) {
      if (known.amount !== input.amount || known.ttlMs !== input.ttlMs) return { kind: "idempotency_conflict" }
      return { kind: "ok", hold: known.hold, replayed: true, balance: balanceOf(budget) }
    }

    const { holds, cap } = budget.definition
    const ttl = input.ttlMs ?? holds.defaultTtlMs
    if (ttl < MIN_HOLD_TTL_MS || ttl > holds.maxTtlMs) {
      return { kind: "invalid_ttl", ttlMs: ttl, maxTtlMs: holds.maxTtlMs }
    }

    if (budget.consumed + budget.held + input.amount > cap) {
      const remedy: Remedy = input.amount <= cap - budget.consumed ? "release_holds" : "raise_limit"
      return {
        kind: "exceeded",
        remedy,
        remaining: sub(sub(cap, budget.consumed), budget.held),
        held: budget.held,
        balance: balanceOf(budget),
      }
    }

    const hold: Hold = {
      id: `h_${++budget.holdSeq}`,
      amount: input.amount,
      expiresAt: now + ttl,
      state: { status: "open" },
    }
    budget.holds.set(hold.id, hold)
    budget.open.add(hold)
    budget.held = add(budget.held, hold.amount)
    budget.idempotency.set(input.idempotencyKey, { amount: input.amount, ttlMs: input.ttlMs, hold })
    budget.operations.authorize += 1
    return { kind: "ok", hold, replayed: false, balance: balanceOf(budget) }
  }

  settle(key: string, holdId: string, actual: Units, now: number): SettleOutcome {
    const budget = this.budgets.get(key)
    if (!budget) return { kind: "budget_not_found" }
    expire(budget, now)
    const hold = budget.holds.get(holdId)
    if (!hold) return { kind: "hold_not_found", holdId }

    const { state } = hold
    switch (state.status) {
      case "settled":
        if (state.actual !== actual) return { kind: "hold_closed", holdId, status: state.expired ? "expired" : "settled" }
        return {
          kind: "ok",
          actual,
          released: sub(hold.amount, actual),
          expired: state.expired,
          replayed: true,
          balance: balanceOf(budget),
        }
      case "released":
        return { kind: "hold_closed", holdId, status: "released" }
      case "open":
        if (actual > hold.amount) return { kind: "hold_amount_exceeded", holdId, maximum: hold.amount, actual }
        close(budget, hold, { status: "settled", actual, expired: false })
        budget.operations.settle += 1
        return {
          kind: "ok",
          actual,
          released: sub(hold.amount, actual),
          expired: false,
          replayed: false,
          balance: balanceOf(budget),
        }
    }
  }

  release(key: string, holdId: string, now: number): ReleaseOutcome {
    const budget = this.budgets.get(key)
    if (!budget) return { kind: "budget_not_found" }
    expire(budget, now)
    const hold = budget.holds.get(holdId)
    if (!hold) return { kind: "hold_not_found", holdId }

    const { state } = hold
    switch (state.status) {
      case "released":
        return { kind: "ok", released: hold.amount, replayed: true, balance: balanceOf(budget) }
      case "settled":
        return { kind: "hold_closed", holdId, status: state.expired ? "expired" : "settled" }
      case "open":
        close(budget, hold, { status: "released" })
        budget.operations.release += 1
        return { kind: "ok", released: hold.amount, replayed: false, balance: balanceOf(budget) }
    }
  }
}

function expire(budget: Budget, now: number): void {
  for (const hold of budget.open) {
    if (hold.expiresAt <= now) close(budget, hold, { status: "settled", actual: hold.amount, expired: true })
  }
}

function close(budget: Budget, hold: Hold, state: Exclude<HoldState, { status: "open" }>): void {
  hold.state = state
  budget.open.delete(hold)
  budget.held = sub(budget.held, hold.amount)
  if (state.status === "settled") budget.consumed = add(budget.consumed, state.actual)
}

const balanceOf = (budget: Budget): Balance => ({
  cap: budget.definition.cap,
  consumed: budget.consumed,
  held: budget.held,
  limitId: budget.definition.limitId,
})

const view = (budget: Budget): BudgetView => ({
  key: budget.key,
  definition: budget.definition,
  version: budget.version,
  balance: balanceOf(budget),
  operations: { ...budget.operations },
})
