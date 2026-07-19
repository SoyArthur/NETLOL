import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eventBus } from '@/lib/event-bus'
import type { RealtimeEvent } from '@/types'

export const eventsRoutes = new Hono()

// GET /api/events — SSE stream of realtime events.
// No auth — events are scoped to the public bus.
eventsRoutes.get('/', (c) => {
  return streamSSE(c, async (stream) => {
    // Initial pulse — proves the stream is alive.
    await stream.writeSSE({ data: JSON.stringify({ type: 'pulse' } as RealtimeEvent) })

    // Forward every published event to this client.
    const unsub = eventBus.subscribe(async (ev) => {
      try {
        await stream.writeSSE({ data: JSON.stringify(ev) })
      } catch {
        /* drop — client disconnected */
      }
    })

    // Heartbeat every 25s keeps proxies from closing the connection.
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: 'pulse' } as RealtimeEvent) })
        .catch(() => { /* drop */ })
    }, 25_000)

    // Cleanup when the client disconnects.
    stream.onAbort(() => {
      unsub()
      clearInterval(keepAlive)
    })
  })
})
