import { Hono } from 'hono'
import { db } from '@/lib/db'
import { newThreadId } from '@/lib/nanoid'
import {
  serializeConversation, serializeAgent, serializeReputation,
} from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'
import type { Conversation, Agent, Reputation } from '@/types'

export const conversationRoutes = new Hono<{ Variables: Vars }>()

const CONV_INCLUDE = {
  agentA: true,
  agentB: true,
} as const

// GET /api/conversations            → list
// GET /api/conversations?id=xxx      → single with agentA/B + reputationA/B
conversationRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.query('id')
    if (id) {
      const conv = await db.conversation.findUnique({
        where: { id }, include: CONV_INCLUDE,
      })
      if (!conv) return c.json({ error: 'not found' }, 404)
      const isOwner =
        conv.agentA.ownerId === profile.id || conv.agentB.ownerId === profile.id
      if (!isOwner) return c.json({ error: 'forbidden' }, 403)
      const [repA, repB] = await Promise.all([
        db.reputation.findUnique({ where: { agentId: conv.agentAId } }),
        db.reputation.findUnique({ where: { agentId: conv.agentBId } }),
      ])
      const payload: Conversation & {
        agentA?: Agent; agentB?: Agent
        reputationA?: Reputation; reputationB?: Reputation
      } = {
        ...serializeConversation(conv),
        agentA: serializeAgent(conv.agentA),
        agentB: serializeAgent(conv.agentB),
        reputationA: repA ? serializeReputation(repA) : undefined,
        reputationB: repB ? serializeReputation(repB) : undefined,
      }
      return c.json({ conversation: payload })
    }
    const ownedAgentIds = (await db.agent.findMany({
      where: { ownerId: profile.id }, select: { id: true },
    })).map((a) => a.id)
    const rows = await db.conversation.findMany({
      where: {
        OR: [
          { agentAId: { in: ownedAgentIds } },
          { agentBId: { in: ownedAgentIds } },
        ],
      },
      include: CONV_INCLUDE,
      orderBy: { lastMessageAt: 'desc' },
    })
    return c.json({ conversations: rows.map(serializeConversation) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/conversations {agentUid} — upsert between user's first agent & target
conversationRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const { agentUid } = await c.req.json<{ agentUid?: string }>()
    if (!agentUid) return c.json({ error: 'agentUid is required' }, 400)
    const myAgent = await db.agent.findFirst({
      where: { ownerId: profile.id },
      orderBy: { createdAt: 'asc' },
    })
    if (!myAgent) {
      return c.json(
        { error: 'you must create an agent first' },
        400,
      )
    }
    const target = await db.agent.findUnique({ where: { uid: agentUid } })
    if (!target) return c.json({ error: 'agent not found' }, 404)
    if (target.id === myAgent.id) {
      return c.json({ error: 'cannot converse with yourself' }, 400)
    }
    const existing = await db.conversation.findFirst({
      where: {
        OR: [
          { agentAId: myAgent.id, agentBId: target.id },
          { agentAId: target.id, agentBId: myAgent.id },
        ],
      },
      include: CONV_INCLUDE,
    })
    if (existing) {
      return c.json({ conversation: serializeConversation(existing) })
    }
    const created = await db.conversation.create({
      data: {
        threadId: newThreadId('dm'),
        agentAId: myAgent.id,
        agentBId: target.id,
      },
      include: CONV_INCLUDE,
    })
    return c.json(
      { conversation: serializeConversation(created) },
      201,
    )
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
