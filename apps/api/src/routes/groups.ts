import { Hono } from 'hono'
import { db } from '@/lib/db'
import { newThreadId } from '@/lib/nanoid'
import { PLANS } from '@/lib/constants'
import { fullPermissions, emptyPermissions } from '@/lib/permissions'
import { serializeGroupChat, serializeGcMember } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const groupRoutes = new Hono<{ Variables: Vars }>()

const GC_INCLUDE = {
  members: { include: { agent: true } },
  roles: { orderBy: { createdAt: 'asc' as const } },
} as const

async function isAdminOrOwner(profileId: string, gcId: string) {
  const gc = await db.groupChat.findUnique({
    where: { id: gcId },
    select: { ownerHumanId: true },
  })
  if (!gc) return { ok: false, status: 404 as const }
  if (gc.ownerHumanId === profileId) return { ok: true as const }
  const adminMember = await db.gcMember.findFirst({
    where: { gcId, isAdmin: true, agent: { ownerId: profileId } },
  })
  if (adminMember) return { ok: true as const }
  return { ok: false, status: 403 as const }
}

// GET /api/groups — owned + member-of
groupRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const owned = await db.groupChat.findMany({
      where: { ownerHumanId: profile.id },
      include: GC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    const memberGcs = await db.groupChat.findMany({
      where: {
        members: { some: { agent: { ownerId: profile.id } } },
        NOT: { ownerHumanId: profile.id },
      },
      include: GC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    const all = [...owned, ...memberGcs].map(serializeGroupChat)
    return c.json({ groups: all })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/groups — create (free blocked, plan-limited)
groupRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const plan = PLANS[profile.plan as keyof typeof PLANS]
    if (!plan.groupChats) {
      return c.json(
        { error: `Plan ${profile.plan} cannot create group chats` },
        403,
      )
    }
    const body = await c.req.json<{
      name?: string; isPublic?: boolean; maxMembers?: number | null
    }>()
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    const firstAgent = await db.agent.findFirst({
      where: { ownerId: profile.id },
      orderBy: { createdAt: 'asc' },
    })
    const threadId = newThreadId('gc')
    const gc = await db.groupChat.create({
      data: {
        threadId,
        name: body.name.trim(),
        isPublic: body.isPublic ?? true,
        maxMembers: body.maxMembers ?? null,
        createdById: firstAgent?.id ?? null,
        ownerHumanId: profile.id,
        roles: {
          create: [
            { name: 'Member', permissions: emptyPermissions() },
            { name: 'Admin', permissions: fullPermissions() },
          ],
        },
      },
      include: GC_INCLUDE,
    })
    const ownerAgents = await db.agent.findMany({ where: { ownerId: profile.id } })
    if (ownerAgents.length) {
      await db.gcMember.createMany({
        data: ownerAgents.map((a) => ({
          gcId: gc.id, agentId: a.id, isAdmin: true,
        })),
        skipDuplicates: true,
      })
    }
    const fresh = await db.groupChat.findUnique({
      where: { id: gc.id }, include: GC_INCLUDE,
    })
    return c.json({ group: serializeGroupChat(fresh) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/groups/:id — single
groupRoutes.get('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const gc = await db.groupChat.findUnique({
      where: { id }, include: GC_INCLUDE,
    })
    if (!gc) return c.json({ error: 'not found' }, 404)
    const isOwner = gc.ownerHumanId === profile.id
    const isMember = gc.members.some((m) => m.agent.ownerId === profile.id)
    if (!gc.isPublic && !isOwner && !isMember) {
      return c.json({ error: 'forbidden' }, 403)
    }
    return c.json({ group: serializeGroupChat(gc) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// PATCH /api/groups/:id — admin only
groupRoutes.patch('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const gc = await db.groupChat.findUnique({ where: { id } })
    if (!gc) return c.json({ error: 'not found' }, 404)
    const isAdmin =
      gc.ownerHumanId === profile.id ||
      !!(await db.gcMember.findFirst({
        where: { gcId: id, isAdmin: true, agent: { ownerId: profile.id } },
      }))
    if (!isAdmin) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json<{
      name?: string; avatarUrl?: string | null; isPublic?: boolean
    }>()
    const update: Record<string, unknown> = {}
    if (body.name !== undefined) update.name = body.name
    if (body.avatarUrl !== undefined) update.avatarUrl = body.avatarUrl
    if (body.isPublic !== undefined) update.isPublic = body.isPublic
    const updated = await db.groupChat.update({
      where: { id }, data: update as never, include: GC_INCLUDE,
    })
    return c.json({ group: serializeGroupChat(updated) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/groups/:id — owner only
groupRoutes.delete('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const gc = await db.groupChat.findUnique({ where: { id } })
    if (!gc) return c.json({ error: 'not found' }, 404)
    if (gc.ownerHumanId !== profile.id) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await db.groupChat.delete({ where: { id } })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/groups/:id/members
groupRoutes.get('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const gc = await db.groupChat.findUnique({ where: { id } })
    if (!gc) return c.json({ error: 'not found' }, 404)
    const isOwner = gc.ownerHumanId === profile.id
    const isMember = !!(await db.gcMember.findFirst({
      where: { gcId: id, agent: { ownerId: profile.id } },
    }))
    if (!gc.isPublic && !isOwner && !isMember) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const members = await db.gcMember.findMany({
      where: { gcId: id },
      include: { agent: true },
      orderBy: { joinedAt: 'asc' },
    })
    return c.json({ members: members.map(serializeGcMember) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/groups/:id/members — admin/owner; plan-limited
groupRoutes.post('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const check = await isAdminOrOwner(profile.id, id)
    if (!check.ok) {
      return c.json(
        { error: check.status === 404 ? 'not found' : 'forbidden' },
        check.status,
      )
    }
    const gc = await db.groupChat.findUnique({
      where: { id },
      select: { ownerHumanId: true, maxMembers: true },
    })
    if (!gc) return c.json({ error: 'not found' }, 404)
    const { agentUid, isAdmin } = await c.req.json<{
      agentUid?: string; isAdmin?: boolean
    }>()
    if (!agentUid) return c.json({ error: 'agentUid is required' }, 400)
    const agent = await db.agent.findUnique({ where: { uid: agentUid } })
    if (!agent) return c.json({ error: 'agent not found' }, 404)
    if (profile.plan === 'pro') {
      const memberCount = await db.gcMember.count({ where: { gcId: id } })
      const exists = await db.gcMember.findUnique({
        where: { gcId_agentId: { gcId: id, agentId: agent.id } },
      })
      if (!exists && memberCount >= (PLANS.pro.groupChatMaxMembers as number)) {
        return c.json(
          { error: `Pro plan max ${PLANS.pro.groupChatMaxMembers} members per GC` },
          403,
        )
      }
    }
    if (gc.maxMembers !== null) {
      const memberCount = await db.gcMember.count({ where: { gcId: id } })
      const exists = await db.gcMember.findUnique({
        where: { gcId_agentId: { gcId: id, agentId: agent.id } },
      })
      if (!exists && memberCount >= gc.maxMembers) {
        return c.json(
          { error: `Group chat is full (max ${gc.maxMembers})` },
          403,
        )
      }
    }
    const member = await db.gcMember.upsert({
      where: { gcId_agentId: { gcId: id, agentId: agent.id } },
      create: { gcId: id, agentId: agent.id, isAdmin: isAdmin ?? false },
      update: { isAdmin: isAdmin ?? false },
      include: { agent: true },
    })
    return c.json({ member: serializeGcMember(member) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/groups/:id/members?agentUid=xxx — admin/owner
groupRoutes.delete('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const check = await isAdminOrOwner(profile.id, id)
    if (!check.ok) {
      return c.json(
        { error: check.status === 404 ? 'not found' : 'forbidden' },
        check.status,
      )
    }
    const agentUid = c.req.query('agentUid')
    if (!agentUid) return c.json({ error: 'agentUid is required' }, 400)
    const agent = await db.agent.findUnique({ where: { uid: agentUid } })
    if (!agent) return c.json({ error: 'agent not found' }, 404)
    await db.gcMember.deleteMany({
      where: { gcId: id, agentId: agent.id },
    })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
