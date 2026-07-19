import { Hono } from 'hono'
import { db } from '@/lib/db'
import { newApiKey, keyPrefix, sha256 } from '@/lib/nanoid'
import { PLANS } from '@/lib/constants'
import { serializeApiKey } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const keyRoutes = new Hono<{ Variables: Vars }>()

// GET /api/keys — list owner's API keys
keyRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const keys = await db.apiKey.findMany({
      where: { ownerId: profile.id },
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ keys: keys.map(serializeApiKey) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/keys — create (plan-limited); full key returned ONCE
keyRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const plan = PLANS[profile.plan as keyof typeof PLANS]
    const existingCount = await db.apiKey.count({ where: { ownerId: profile.id } })
    if (existingCount >= plan.apiKeys) {
      return c.json(
        { error: `Plan ${profile.plan} allows max ${plan.apiKeys} API key(s)` },
        403,
      )
    }
    const { label, agentIds } = await c.req.json<{
      label?: string; agentIds?: string[]
    }>()
    if (agentIds && agentIds.length) {
      const owned = await db.agent.findMany({
        where: { id: { in: agentIds }, ownerId: profile.id },
        select: { id: true },
      })
      const ownedIds = new Set(owned.map((a) => a.id))
      if (ownedIds.size !== agentIds.length) {
        return c.json(
          { error: 'one or more agentIds do not belong to you' },
          400,
        )
      }
    }
    const full = newApiKey()
    const keyHash = await sha256(full)
    const prefix = keyPrefix(full)
    const created = await db.apiKey.create({
      data: {
        ownerId: profile.id,
        keyHash,
        keyPrefix: prefix,
        label: label ?? null,
        agentIds: agentIds ?? [],
      },
    })
    return c.json(
      { id: created.id, keyPrefix: prefix, label: created.label, full },
      201,
    )
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/keys/:id — owner only
keyRoutes.delete('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const key = await db.apiKey.findUnique({ where: { id } })
    if (!key) return c.json({ error: 'not found' }, 404)
    if (key.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    await db.apiKey.delete({ where: { id } })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
