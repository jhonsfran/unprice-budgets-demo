import { BudgetExceededError, Unprice } from "@unprice/budgets"
import { describe, expect, it } from "vitest"
import { createBudgetApi } from "../src/worker/api"

async function setup(cap = "5") {
  let now = 1_000_000
  const api = createBudgetApi({ now: () => now })
  const unprice = new Unprice({ token: "test", fetch: api, baseUrl: "http://local", disableTelemetry: true, retry: { attempts: 0 } })
  const key = "run:test"
  const upserted = await unprice.budgets.upsert({ key, unit: "USD", limits: [{ amount: cap, window: "never" }] })
  expect(upserted.error).toBeUndefined()
  return { unprice, key, advance: (ms: number) => (now += ms) }
}

describe("budget ledger over the budgets HTTP contract", () => {
  it("authorizes a hold that fits and reports it in the balance", async () => {
    const { unprice, key } = await setup()
    const { result } = await unprice.budgets.authorize({ key, amount: "1.25", idempotencyKey: "a" })
    expect(result).toMatchObject({
      allowed: true,
      holdId: "h_1",
      amount: "1.25",
      expiresAt: 1_000_000 + 900_000,
      replayed: false,
      created: false,
      balance: { remaining: "3.75", held: "1.25" },
    })
    expect(result?.balance.limits).toEqual([
      { id: "never", window: "never", enforce: "hard", amount: "5", consumed: "0", held: "1.25", remaining: "3.75", resetsAt: null },
    ])
  })

  it("denies with release_holds when settling open holds would make room", async () => {
    const { unprice, key } = await setup()
    await unprice.budgets.authorize({ key, amount: "4", idempotencyKey: "a" })
    const denied = await unprice.budget(key).spend({ estimate: "2" }, async () => ({ value: "ran", actual: "1" })).catch((e: unknown) => e)
    expect(denied).toBeInstanceOf(BudgetExceededError)
    const { blocked, balance } = denied as BudgetExceededError
    expect(blocked).toEqual({ reason: "limit", limitId: "never", window: "never", remaining: "1", held: "4", resetsAt: null, remedy: "release_holds" })
    expect(balance.remaining).toBe("1")
  })

  it("denies with raise_limit when consumed spend leaves no room", async () => {
    const { unprice, key } = await setup()
    const hold = await unprice.budgets.authorize({ key, amount: "4.5", idempotencyKey: "a" })
    await unprice.budgets.settle({ key, holdId: hold.result!.holdId, amount: "4" })
    const denied = await unprice.budget(key).spend({ estimate: "1.5" }, async () => ({ value: "ran", actual: "1" })).catch((e: unknown) => e)
    expect((denied as BudgetExceededError).blocked.remedy).toBe("raise_limit")
    expect((denied as BudgetExceededError).blocked).toMatchObject({ remaining: "1", held: "0" })
  })

  it("settles below the hold and returns the remainder", async () => {
    const { unprice, key } = await setup()
    const hold = await unprice.budgets.authorize({ key, amount: "2", idempotencyKey: "a" })
    const settled = await unprice.budgets.settle({ key, holdId: hold.result!.holdId, amount: "0.35" })
    expect(settled.result).toMatchObject({
      holdId: "h_1",
      actual: "0.35",
      released: "1.65",
      expired: false,
      crossed: [],
      replayed: false,
      balance: { remaining: "4.65", held: "0" },
    })
  })

  it("refuses a settle above the hold with 409 and keeps the hold open", async () => {
    const { unprice, key } = await setup()
    const hold = await unprice.budgets.authorize({ key, amount: "1", idempotencyKey: "a" })
    const over = await unprice.budgets.settle({ key, holdId: "h_1", amount: "1.00000001" })
    expect(over.error).toMatchObject({
      code: "CONFLICT",
      details: { kind: "hold_amount_exceeded", holdId: "h_1", maximum: "1", actual: "1.00000001" },
    })
    const settled = await unprice.budgets.settle({ key, holdId: hold.result!.holdId, amount: "1" })
    expect(settled.result?.balance.remaining).toBe("4")
  })

  it("replays an authorize and a settle with the same idempotent request", async () => {
    const { unprice, key } = await setup()
    await unprice.budgets.authorize({ key, amount: "1", idempotencyKey: "same" })
    const replay = await unprice.budgets.authorize({ key, amount: "1", idempotencyKey: "same" })
    expect(replay.result).toMatchObject({ holdId: "h_1", replayed: true, balance: { held: "1" } })

    const conflict = await unprice.budgets.authorize({ key, amount: "2", idempotencyKey: "same" })
    expect(conflict.error?.code).toBe("CONFLICT")

    await unprice.budgets.settle({ key, holdId: "h_1", amount: "0.5" })
    const settleReplay = await unprice.budgets.settle({ key, holdId: "h_1", amount: "0.5" })
    expect(settleReplay.result).toMatchObject({ actual: "0.5", released: "0.5", replayed: true, balance: { remaining: "4.5" } })
  })

  it("counts an expired open hold at its full amount", async () => {
    const { unprice, key, advance } = await setup()
    await unprice.budgets.authorize({ key, amount: "3", ttlMs: 1000, idempotencyKey: "a" })
    advance(1000)
    const late = await unprice.budgets.settle({ key, holdId: "h_1", amount: "1" })
    expect(late.error?.message).toBe("Hold h_1 expired and was settled at its full amount")
    const fits = await unprice.budgets.authorize({ key, amount: "2.5", idempotencyKey: "b" })
    expect(fits.error?.code).toBe("BUDGET_EXCEEDED")
  })

  it("refuses to lower the cap below consumed plus held", async () => {
    const { unprice, key } = await setup()
    await unprice.budgets.authorize({ key, amount: "3", idempotencyKey: "a" })
    const lowered = await unprice.budgets.upsert({ key, unit: "USD", limits: [{ amount: "2", window: "never" }] })
    expect(lowered.error).toMatchObject({ code: "CONFLICT", details: { kind: "limit_below_usage", minimum: "3", requested: "2" } })
  })

  it("rejects caps above $20 and non-USD units at the boundary", async () => {
    const { unprice } = await setup()
    const big = await unprice.budgets.upsert({ key: "k", unit: "USD", limits: [{ amount: "20.5", window: "never" }] })
    expect(big.error?.code).toBe("BAD_REQUEST")
    const eur = await unprice.budgets.upsert({ key: "k", unit: "EUR", limits: [{ amount: "1", window: "never" }] })
    expect(eur.error?.message).toBe("unit must be USD in this demo")
  })
})
