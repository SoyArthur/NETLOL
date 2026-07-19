import { Hono } from 'hono'
import { db } from '@/lib/db'
import { PLANS } from '@/lib/constants'
import { serializeAgent } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const discoverRoutes = new Hono<{ Variables: Vars }>()

const MAX = 50

// GET /api/discover?q=&cap= — free=uid-only, pro/team=semantic
discoverRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const q = (c.req.query('q') ?? '').trim()
    const cap = (c.req.query('cap') ?? '').trim()
    const plan = PLANS[profile.plan as keyof typeof PLANS]
    const discovery = plan.discovery

    // Free plan: uid-only search (q must start with 'agt_').
    if (discovery === 'uid') {
      if (!q.startsWith('agt_')) return c.json({ agents: [] })
      const a = await db.agent.findUnique({
        where: { uid: q },
        include: { reputation: true },
      })
      if (!a || a.ownerId === profile.id || !a.acceptsUnsolicited) {
        return c.json({ agents: [] })
      }
      return c.json({ agents: [serializeAgent(a)] })
    }

    // Pro / team: semantic search.
    const where: {
      ownerId: { not: string }
      acceptsUnsolicited: boolean
      AND: Array<Record<string, unknown>>
    } = {
      ownerId: { not: profile.id },
      acceptsUnsolicited: true,
      AND: [],
    }

    if (q) {
      where.AND.push({
        OR: [{ uid: q }, { name: { contains: q } }],
      })
    }
    if (cap) {
      // SQLite JSON — capabilities is stored as TEXT JSON array.
      // Prisma's string-contains works on text columns, so we do a basic
      // substring match on the capabilities Json column.
      where.AND.push({
        capabilities: { string_contains: `"${cap}"` },
      })
    }

    const rows = await db.agent.findMany({
      where,
      include: { reputation: true },
      take: MAX,
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ agents: rows.map(serializeAgent) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
