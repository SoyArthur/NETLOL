import { Hono } from 'hono'
import { db } from '@/lib/db'
import { newServerSlug } from '@/lib/nanoid'
import { fullPermissions, emptyPermissions, checkPermission } from '@/lib/permissions'
import { serializeServer, serializeChannel, serializeServerMember } from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const serverRoutes = new Hono<{ Variables: Vars }>()

const SERVER_INCLUDE = {
  channels: { orderBy: { position: 'asc' as const } },
  members: { include: { agent: true } },
  roles: { orderBy: { position: 'asc' as const } },
} as const

// GET /api/servers — owned + member-of
serverRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const owned = await db.server.findMany({
      where: { ownerHumanId: profile.id },
      include: SERVER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    const memberServers = await db.server.findMany({
      where: {
        members: { some: { agent: { ownerId: profile.id } } },
        NOT: { ownerHumanId: profile.id },
      },
      include: SERVER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    const all = [...owned, ...memberServers].map(serializeServer)
    return c.json({ servers: all })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/servers — create
serverRoutes.post('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const body = await c.req.json<{
      name?: string; slug?: string; description?: string
      isPublic?: boolean
    }>()
    if (!body.name?.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    const firstAgent = await db.agent.findFirst({
      where: { ownerId: profile.id },
      orderBy: { createdAt: 'asc' },
    })
    const slug = body.slug?.trim() || newServerSlug()
    const existing = await db.server.findUnique({ where: { slug } })
    if (existing) return c.json({ error: 'slug already taken' }, 409)
    const server = await db.server.create({
      data: {
        slug,
        name: body.name.trim(),
        description: body.description ?? null,
        isPublic: body.isPublic ?? true,
        createdById: firstAgent?.id ?? null,
        ownerHumanId: profile.id,
        channels: {
          create: [
            { name: 'general', position: 0 },
            { name: 'showcase', position: 1 },
          ],
        },
        roles: {
          create: [
            { name: 'Member', permissions: emptyPermissions(), position: 0 },
            { name: 'Admin', permissions: fullPermissions(), position: 1 },
          ],
        },
      },
      include: SERVER_INCLUDE,
    })
    if (firstAgent) {
      const ownerAgents = await db.agent.findMany({ where: { ownerId: profile.id } })
      if (ownerAgents.length) {
        await db.serverMember.createMany({
          data: ownerAgents.map((a) => ({
            serverId: server.id, agentId: a.id,
            isAdmin: true, roleIds: [],
          })),
          skipDuplicates: true,
        })
      }
    }
    const fresh = await db.server.findUnique({
      where: { id: server.id }, include: SERVER_INCLUDE,
    })
    return c.json({ server: serializeServer(fresh) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/servers/:id — single
serverRoutes.get('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const server = await db.server.findUnique({
      where: { id }, include: SERVER_INCLUDE,
    })
    if (!server) return c.json({ error: 'not found' }, 404)
    const isOwner = server.ownerHumanId === profile.id
    const isMember = server.members.some((m) => m.agent.ownerId === profile.id)
    if (!server.isPublic && !isOwner && !isMember) {
      return c.json({ error: 'forbidden' }, 403)
    }
    return c.json({ server: serializeServer(server) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// PATCH /api/servers/:id — manage_server permission
serverRoutes.patch('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const ok = await checkPermission(profile.id, 'server', id, 'manage_server')
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json<{
      name?: string; description?: string
      isPublic?: boolean; avatarUrl?: string | null
    }>()
    const update: Record<string, unknown> = {}
    if (body.name !== undefined) update.name = body.name
    if (body.description !== undefined) update.description = body.description
    if (body.isPublic !== undefined) update.isPublic = body.isPublic
    if (body.avatarUrl !== undefined) update.avatarUrl = body.avatarUrl
    const updated = await db.server.update({
      where: { id }, data: update as never, include: SERVER_INCLUDE,
    })
    return c.json({ server: serializeServer(updated) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/servers/:id — owner only
serverRoutes.delete('/:id', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const server = await db.server.findUnique({ where: { id } })
    if (!server) return c.json({ error: 'not found' }, 404)
    if (server.ownerHumanId !== profile.id) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await db.server.delete({ where: { id } })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/servers/:id/channels
serverRoutes.get('/:id/channels', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const server = await db.server.findUnique({
      where: { id },
      include: { channels: { orderBy: { position: 'asc' } } },
    })
    if (!server) return c.json({ error: 'not found' }, 404)
    const isOwner = server.ownerHumanId === profile.id
    const isMember = !!(await db.serverMember.findFirst({
      where: { serverId: id, agent: { ownerId: profile.id } },
    }))
    if (!server.isPublic && !isOwner && !isMember) {
      return c.json({ error: 'forbidden' }, 403)
    }
    return c.json({ channels: server.channels.map(serializeChannel) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/servers/:id/channels — manage_channels
serverRoutes.post('/:id/channels', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const ok = await checkPermission(profile.id, 'server', id, 'manage_channels')
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const { name } = await c.req.json<{ name?: string }>()
    if (!name?.trim()) return c.json({ error: 'name is required' }, 400)
    const max = await db.serverChannel.aggregate({
      where: { serverId: id }, _max: { position: true },
    })
    const position = (max._max.position ?? -1) + 1
    const channel = await db.serverChannel.create({
      data: { serverId: id, name: name.trim(), position },
    })
    return c.json({ channel: serializeChannel(channel) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// GET /api/servers/:id/members
serverRoutes.get('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const server = await db.server.findUnique({ where: { id } })
    if (!server) return c.json({ error: 'not found' }, 404)
    const isOwner = server.ownerHumanId === profile.id
    const isMember = !!(await db.serverMember.findFirst({
      where: { serverId: id, agent: { ownerId: profile.id } },
    }))
    if (!server.isPublic && !isOwner && !isMember) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const members = await db.serverMember.findMany({
      where: { serverId: id },
      include: { agent: true },
      orderBy: { joinedAt: 'asc' },
    })
    return c.json({ members: members.map(serializeServerMember) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/servers/:id/members — invite permission
serverRoutes.post('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const ok = await checkPermission(profile.id, 'server', id, 'invite')
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const { agentUid, isAdmin, roleIds } = await c.req.json<{
      agentUid?: string; isAdmin?: boolean; roleIds?: string[]
    }>()
    if (!agentUid) return c.json({ error: 'agentUid is required' }, 400)
    const agent = await db.agent.findUnique({ where: { uid: agentUid } })
    if (!agent) return c.json({ error: 'agent not found' }, 404)
    const member = await db.serverMember.upsert({
      where: { serverId_agentId: { serverId: id, agentId: agent.id } },
      create: {
        serverId: id, agentId: agent.id,
        isAdmin: isAdmin ?? false, roleIds: roleIds ?? [],
      },
      update: {
        isAdmin: isAdmin ?? false,
        ...(roleIds ? { roleIds } : {}),
      },
      include: { agent: true },
    })
    return c.json({ member: serializeServerMember(member) }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// DELETE /api/servers/:id/members?agentUid=xxx — kick permission
serverRoutes.delete('/:id/members', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const ok = await checkPermission(profile.id, 'server', id, 'kick')
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const agentUid = c.req.query('agentUid')
    if (!agentUid) return c.json({ error: 'agentUid is required' }, 400)
    const agent = await db.agent.findUnique({ where: { uid: agentUid } })
    if (!agent) return c.json({ error: 'agent not found' }, 404)
    await db.serverMember.deleteMany({
      where: { serverId: id, agentId: agent.id },
    })
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
