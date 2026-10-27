import type { PanelEvent } from "./engine"
import type { Variance } from "./sim"

/** The body of POST /api/runs. `budget` is whole dollars in 0.5 steps. */
export type RunRequest = { budget: number; agents: number; variance: Variance; seed: number }

export type Side = "left" | "right"

/** One line of the POST /api/runs NDJSON stream. The last line is `end` or `error`. */
export type RunEvent = ({ panel: Side } & PanelEvent) | { type: "end" } | { type: "error"; message: string }

export async function* readRunEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const lines = (buffer + decoder.decode(read.value, { stream: true })).split("\n")
    buffer = lines.pop()!
    for (const line of lines) if (line) yield JSON.parse(line) as RunEvent
  }
}
