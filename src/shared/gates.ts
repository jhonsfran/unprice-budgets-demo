import { BudgetExceededError, type BudgetHandle } from "@unprice/budgets"
import type { Gate, Sleep } from "./engine"
import { type Micros, ZERO, addMicros, toDecimal } from "./money"

export function afterTheFactGate(cap: Micros): Gate {
  let recorded = ZERO
  return {
    async run(spec, work, emit) {
      if (recorded >= cap) {
        emit({ type: "blocked", agent: spec.agent })
        return "stop"
      }
      emit({ type: "started", agent: spec.agent, reserved: ZERO })
      await work()
      recorded = addMicros(recorded, spec.actual)
      emit({ type: "finished", agent: spec.agent, actual: spec.actual, reserved: ZERO })
      return "continue"
    },
  }
}

export function unpriceGate(budget: BudgetHandle, sleep: Sleep): Gate {
  return {
    async run(spec, work, emit) {
      for (;;) {
        try {
          await budget.spend({ estimate: toDecimal(spec.estimate) }, async () => {
            emit({ type: "started", agent: spec.agent, reserved: spec.estimate })
            await work()
            // Emitted before the settle request so the panel never shows a hold the server already returned.
            emit({ type: "finished", agent: spec.agent, actual: spec.actual, reserved: spec.estimate })
            return { value: undefined, actual: toDecimal(spec.actual) }
          })
          return "continue"
        } catch (error) {
          if (!(error instanceof BudgetExceededError)) throw error
          emit({ type: "denied", agent: spec.agent, remedy: error.blocked.remedy })
          if (error.blocked.remedy !== "release_holds") return "stop"
          await sleep(150 + Math.random() * 150)
        }
      }
    },
  }
}
