import { Hono } from 'hono'
import { db } from '@/lib/db'
import { VETO_TIMEOUT_BOUNDS } from '@/lib/constants'
import { getProfile, Vars } from '../_lib/auth.js'

export const profileRoutes = new Hono<{ Variables: Vars }>()

// GET /api/profile — current profile (already serialized by middleware)
profileRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  // Merge in wallet fields via raw SQL — the cached Prisma client may be
  // running with an older schema that doesn't yet know about
  // walletAddress/walletChain columns.
  const row = await db
    .$queryRaw<{ walletAddress: string | null; walletChain: string | null }[]>`
      SELECT walletAddress, walletChain FROM Profile WHERE id = ${profile.id}
    `.then((rows) => rows[0] ?? null)
    .catch(() => null)
  if (row) {
    return c.json({
      profile: {
        ...profile,
        walletAddress: row.walletAddress ?? null,
        walletChain: (row.walletChain ?? 'solana') as typeof profile.walletChain,
      },
    })
  }
  return c.json({ profile })
})

// PATCH /api/profile { username?, vetoTimeoutSeconds?, walletAddress?, walletChain? }
profileRoutes.patch('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const body = await c.req.json<{
      username?: string
      vetoTimeoutSeconds?: number
      walletAddress?: string | null
      walletChain?: string
    }>()
    const update: Record<string, unknown> = {}

    if (body.username !== undefined) {
      const u = body.username.trim()
      if (u.length < 3 || u.length > 32) {
        return c.json({ error: 'username must be 3–32 chars' }, 400)
      }
      const clash = await db.profile.findUnique({ where: { username: u } })
      if (clash && clash.id !== profile.id) {
        return c.json({ error: 'username already taken' }, 409)
      }
      update.username = u
    }

    if (body.vetoTimeoutSeconds !== undefined) {
      const v = Math.floor(Number(body.vetoTimeoutSeconds))
      if (!Number.isFinite(v) ||
          v < VETO_TIMEOUT_BOUNDS.min || v > VETO_TIMEOUT_BOUNDS.max) {
        return c.json(
          { error: `vetoTimeoutSeconds must be ${VETO_TIMEOUT_BOUNDS.min}–${VETO_TIMEOUT_BOUNDS.max}` },
          400,
        )
      }
      update.vetoTimeoutSeconds = v
    }

    const hasWallet = body.walletAddress !== undefined || body.walletChain !== undefined
    if (Object.keys(update).length > 0) {
      await db.profile.update({
        where: { id: profile.id },
        data: update as never,
      })
    }
    if (hasWallet) {
      const addr = body.walletAddress !== undefined ? body.walletAddress : null
      const chain = body.walletChain ?? 'solana'
      await db.$executeRaw`
        UPDATE Profile
        SET walletAddress = ${addr},
            walletChain   = ${chain}
        WHERE id = ${profile.id}
      `.catch(() => { /* schema might not have the columns yet */ })
    }

    if (Object.keys(update).length === 0 && !hasWallet) {
      return c.json({ error: 'no fields to update' }, 400)
    }

    const fresh = await db.profile.findUnique({ where: { id: profile.id } })
    if (!fresh) return c.json({ error: 'not found' }, 404)
    const wallet = await db
      .$queryRaw<{ walletAddress: string | null; walletChain: string | null }[]>`
        SELECT walletAddress, walletChain FROM Profile WHERE id = ${profile.id}
      `.then((rows) => rows[0] ?? null)
      .catch(() => null)
    return c.json({
      profile: {
        id: fresh.id,
        email: fresh.email,
        username: fresh.username,
        avatarUrl: fresh.avatarUrl,
        plan: fresh.plan as any,
        planExpiresAt: fresh.planExpiresAt?.toISOString() ?? null,
        vetoTimeoutSeconds: fresh.vetoTimeoutSeconds,
        walletAddress: wallet?.walletAddress ?? null,
        walletChain: (wallet?.walletChain ?? 'solana') as any,
        createdAt: fresh.createdAt.toISOString(),
      },
    })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
