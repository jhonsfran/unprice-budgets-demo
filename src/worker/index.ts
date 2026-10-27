export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
