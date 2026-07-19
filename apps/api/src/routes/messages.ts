import { Hono } from 'hono'
import { db } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { serializeMessage } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const messageRoutes = new Hono<{ Variables: Vars }>()

// GET /api/messages?threadId=xxx — ordered ascending, max 200
messageRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const threadId = c.req.query('threadId')
    if (!threadId) return c.json({ error: 'threadId is required' }, 400)
    const messages = await db.messageEvent.findMany({
      where: { threadId },
      include: { sender: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    return c.json({ messages: messages.map(serializeMessage) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/messages — create + publish realtime event
messageRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const body = await c.req.json<{
      threadId?: string; senderAgentUid?: string
      content?: string; sentByHuman?: boolean
    }>()
    if (!body.threadId || !body.senderAgentUid || !body.content) {
      return c.json(
        { error: 'threadId, senderAgentUid, content are required' },
        400,
      )
    }
    const sender = await db.agent.findUnique({
      where: { uid: body.senderAgentUid },
    })
    if (!sender) return c.json({ error: 'sender agent not found' }, 404)
    if (sender.ownerId !== profile.id) {
      return c.json(
        { error: 'forbidden — you do not own this agent' },
        403,
      )
    }
    const sentByHuman = body.sentByHuman ?? false
    const msg = await db.messageEvent.create({
      data: {
        threadId: body.threadId,
        senderAgentId: sender.id,
        content: body.content,
        sentByHuman,
      },
      include: { sender: true },
    })
    // Update the parent thread's lastMessageAt (and spent for fixed-price convos).
    const gc = await db.groupChat.findUnique({ where: { threadId: body.threadId } })
    if (gc) {
      await db.groupChat.update({
        where: { id: gc.id },
        data: { lastMessageAt: new Date() },
      })
    } else {
      const conv = await db.conversation.findUnique({
        where: { threadId: body.threadId },
      })
      if (conv) {
        const update: { lastMessageAt: Date; spent?: { increment: number } } = {
          lastMessageAt: new Date(),
        }
        if (!sentByHuman && sender.pricingModel === 'fixed' && sender.pricePerRequest > 0) {
          update.spent = { increment: sender.pricePerRequest }
        }
        await db.conversation.update({ where: { id: conv.id }, data: update })
      }
    }
    const serialized = serializeMessage(msg)
    eventBus.publish({ type: 'message', message: serialized })
    return c.json({ message: serialized }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
