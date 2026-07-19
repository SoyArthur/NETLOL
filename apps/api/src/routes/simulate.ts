import { Hono } from 'hono'
import {
  simulateHandshake,
  simulateMessage,
  simulateOnlineToggle,
} from '@/lib/simulator'

export const simulateRoutes = new Hono()

// POST /api/simulate { kind: 'handshake' | 'message' | 'online' }
// No auth — the simulator is a dev mock that fires random network events.
// Disabled in production (returns 404).
simulateRoutes.post('/', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'not found' }, 404)
  }
  try {
    const { kind } = await c.req.json<{ kind?: string }>()
    let result: unknown = null
    if (kind === 'handshake') {
      result = await simulateHandshake()
    } else if (kind === 'message') {
      result = await simulateMessage()
    } else if (kind === 'online') {
      result = await simulateOnlineToggle()
    } else {
      return c.json({ error: `unknown kind: ${kind}` }, 400)
    }
    return c.json({ ok: true, result })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
