import { Hono } from 'hono'
import { db } from '@/lib/db'
import { encrypt, decrypt, maskKey } from '@/lib/crypto'
import { newAgentUid } from '@/lib/nanoid'
import { PLANS } from '@/lib/constants'
import { eventBus } from '@/lib/event-bus'
import { serializeAgent, serializeTool, serializeReputation } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const agentRoutes = new Hono<{ Variables: Vars }>()

const AGENT_INCLUDE = {
  secret: true, tools: true, reputation: true,
} as const

// GET /api/agents — list owner's agents
agentRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const rows = await db.agent.findMany({
      where: { ownerId: profile.id },
      include: AGENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    })
    return c.json({ agents: rows.map(serializeAgent) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/agents — create agent (plan-limited)
agentRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const body = await c.req.json<{
      name?: string; description?: string
      capabilities?: string[]; languages?: string[]
      acceptsUnsolicited?: boolean
      byokProvider?: string | null; byokBaseUrl?: string | null
      model?: string | null
      pricingModel?: string; pricePerRequest?: number
      dailyBudgetUsd?: number | null
      walletAddress?: string | null; walletChain?: string
      llmKey?: string
    }>()
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    const plan = PLANS[profile.plan as keyof typeof PLANS]
    const count = await db.agent.count({ where: { ownerId: profile.id } })
    if (count >= plan.agents) {
      return c.json(
        { error: `Plan ${profile.plan} allows max ${plan.agents} agent(s)` },
        403,
      )
    }
    const uid = newAgentUid()
    const agent = await db.agent.create({
      data: {
        uid,
        ownerId: profile.id,
        name: body.name.trim(),
        description: body.description ?? null,
        capabilities: body.capabilities ?? [],
        languages: body.languages ?? ['en'],
        acceptsUnsolicited: body.acceptsUnsolicited ?? true,
        byokProvider: body.byokProvider ?? null,
        byokBaseUrl: body.byokBaseUrl ?? null,
        model: body.model ?? null,
        pricingModel: body.pricingModel ?? 'free',
        pricePerRequest: body.pricePerRequest ?? 0,
        dailyBudgetUsd: body.dailyBudgetUsd ?? null,
        walletAddress: body.walletAddress ?? null,
        walletChain: body.walletChain ?? 'solana',
      },
      include: AGENT_INCLUDE,
    })
    if (body.llmKey) {
      await db.agentSecret.create({
        data: { agentId: agent.id, llmKeyEncrypted: encrypt(body.llmKey) },
      })
    }
    await db.reputation.create({
      data: {
        agentId: agent.id, jobsCompleted: 0, jobsFailed: 0, jobsVetoed: 0,
        totalEarnedUsd: 0, totalSpentUsd: 0, avgResponseMs: 0,
        successRate: 0, verified: false,
      },
    })
    const fresh = await db.agent.findUnique({
      where: { id: agent.id }, include: AGENT_INCLUDE,
    })
    return c.json({ agent: serializeAgent(fresh) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/agents/:uid — public profile
agentRoutes.get('/:uid', async (c) => {
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({
      where: { uid },
      include: {
        tools: true, reputation: true,
        owner: { select: { username: true } },
      },
    })
    if (!agent) return c.json({ error: 'not found' }, 404)
    return c.json({
      agent: serializeAgent(agent),
      ownerUsername: (agent.owner as { username: string } | null)?.username ?? null,
      reputation: agent.reputation ? serializeReputation(agent.reputation) : null,
      tools: agent.tools ? agent.tools.map(serializeTool) : [],
    })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// PATCH /api/agents/:uid — owner-only update
agentRoutes.patch('/:uid', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const existing = await db.agent.findUnique({ where: { uid } })
    if (!existing) return c.json({ error: 'not found' }, 404)
    if (existing.ownerId !== profile.id) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = await c.req.json<Record<string, unknown>>()
    const { llmKey, ...rest } = body
    const update: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) update[k] = v
    }
    const updated = await db.agent.update({
      where: { uid },
      data: update as never,
      include: { tools: true, reputation: true },
    })
    if (typeof llmKey === 'string' && llmKey) {
      await db.agentSecret.upsert({
        where: { agentId: existing.id },
        create: { agentId: existing.id, llmKeyEncrypted: encrypt(llmKey) },
        update: { llmKeyEncrypted: encrypt(llmKey), updatedAt: new Date() },
      })
    }
    return c.json({ agent: serializeAgent(updated) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/agents/:uid — owner-only delete
agentRoutes.delete('/:uid', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const existing = await db.agent.findUnique({ where: { uid } })
    if (!existing) return c.json({ error: 'not found' }, 404)
    if (existing.ownerId !== profile.id) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await db.agent.delete({ where: { id: existing.id } })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/agents/:uid/secret — masked LLM key (owner only)
agentRoutes.get('/:uid/secret', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({
      where: { uid }, include: { secret: true },
    })
    if (!agent) return c.json({ error: 'not found' }, 404)
    if (agent.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    let masked = '••••'
    if (agent.secret?.llmKeyEncrypted) {
      try {
        const plain = decrypt(agent.secret.llmKeyEncrypted)
        masked = maskKey(plain)
      } catch { masked = '••••' }
    }
    return c.json({ masked })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// PUT /api/agents/:uid/secret — replace LLM key (owner only)
agentRoutes.put('/:uid/secret', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({ where: { uid } })
    if (!agent) return c.json({ error: 'not found' }, 404)
    if (agent.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    const { llmKey } = await c.req.json<{ llmKey?: string }>()
    if (!llmKey) return c.json({ error: 'llmKey is required' }, 400)
    await db.agentSecret.upsert({
      where: { agentId: agent.id },
      create: { agentId: agent.id, llmKeyEncrypted: encrypt(llmKey) },
      update: { llmKeyEncrypted: encrypt(llmKey), updatedAt: new Date() },
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/agents/:uid/tools — list tools (owner only)
agentRoutes.get('/:uid/tools', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({ where: { uid } })
    if (!agent) return c.json({ error: 'not found' }, 404)
    if (agent.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    const tools = await db.agentTool.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: 'asc' },
    })
    return c.json({ tools: tools.map(serializeTool) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/agents/:uid/tools — add tool (plan-limited)
agentRoutes.post('/:uid/tools', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({ where: { uid } })
    if (!agent) return c.json({ error: 'not found' }, 404)
    if (agent.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json<{
      name?: string; description?: string
      type?: string; config?: Record<string, unknown>
      enabled?: boolean
    }>()
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    const plan = PLANS[profile.plan as keyof typeof PLANS]
    const toolCount = await db.agentTool.count({ where: { agentId: agent.id } })
    if (toolCount >= plan.toolsPerAgent) {
      return c.json(
        { error: `Plan ${profile.plan} allows max ${plan.toolsPerAgent} tool(s) per agent` },
        403,
      )
    }
    const tool = await db.agentTool.create({
      data: {
        agentId: agent.id,
        name: body.name.trim(),
        description: body.description ?? null,
        type: body.type ?? 'function',
        config: body.config ?? {},
        enabled: body.enabled ?? true,
      },
    })
    return c.json({ tool: serializeTool(tool) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// PATCH /api/agents/:uid/status — toggle online
agentRoutes.patch('/:uid/status', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const uid = c.req.param('uid')
    const agent = await db.agent.findUnique({ where: { uid } })
    if (!agent) return c.json({ error: 'not found' }, 404)
    if (agent.ownerId !== profile.id) return c.json({ error: 'forbidden' }, 403)
    const { online } = await c.req.json<{ online?: boolean }>()
    if (typeof online !== 'boolean') {
      return c.json({ error: 'online (boolean) is required' }, 400)
    }
    const updated = await db.agent.update({
      where: { id: agent.id },
      data: { online, lastSeen: new Date() },
      include: { tools: true, reputation: true },
    })
    eventBus.publish({
      type: online ? 'agent-online' : 'agent-offline',
      agentId: agent.id,
    })
    return c.json({ agent: serializeAgent(updated) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
