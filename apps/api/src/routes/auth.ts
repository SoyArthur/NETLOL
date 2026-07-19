import { Hono } from 'hono'
import { db } from '@/lib/db'
import { verifyPassword, hashPassword } from '@/lib/auth'
import { rateLimit, rateLimitRetryAfter, getClientIp } from '@/lib/rate-limit'
import { serializeProfile } from '../_lib/serialize.js'
import { setSessionCookie, clearSessionCookie } from '../_lib/auth.js'
import type { Vars } from '../_lib/auth.js'

export const authRoutes = new Hono<{ Variables: Vars }>()

authRoutes.post('/login', async (c) => {
  try {
    const ip = getClientIp(c.req.raw)
    if (!rateLimit(`login:${ip}`, 10, 15 * 60_000)) {
      c.header('Retry-After', String(rateLimitRetryAfter(`login:${ip}`)))
      return c.json({ error: 'too many login attempts' }, 429)
    }
    const body = await c.req.json<{ email?: string; password?: string }>()
    const { email, password } = body
    if (!email || !password) {
      return c.json({ error: 'email and password are required' }, 400)
    }
    const profile = await db.profile.findUnique({ where: { email } })
    if (!profile) return c.json({ error: 'invalid credentials' }, 401)
    const ok = await verifyPassword(password, profile.passwordHash)
    if (!ok) return c.json({ error: 'invalid credentials' }, 401)
    const serialized = serializeProfile(profile)
    setSessionCookie(c, serialized)
    return c.json({ profile: serialized })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

authRoutes.post('/signup', async (c) => {
  try {
    const ip = getClientIp(c.req.raw)
    if (!rateLimit(`signup:${ip}`, 5, 60 * 60_000)) {
      c.header('Retry-After', String(rateLimitRetryAfter(`signup:${ip}`)))
      return c.json({ error: 'too many signup attempts' }, 429)
    }
    const body = await c.req.json<{
      email?: string; password?: string; username?: string
    }>()
    const email = body.email?.trim()
    const username = body.username?.trim()
    const password = body.password
    if (!email || !username || !password) {
      return c.json(
        { error: 'email, username, and password are required' },
        400,
      )
    }
    const conflict = await db.profile.findFirst({
      where: { OR: [{ email }, { username }] },
    })
    if (conflict) {
      return c.json({ error: 'email or username already taken' }, 409)
    }
    const passwordHash = await hashPassword(password)
    const created = await db.profile.create({
      data: {
        email, username, passwordHash,
        plan: 'free', vetoTimeoutSeconds: 30,
      },
    })
    const serialized = serializeProfile(created)
    setSessionCookie(c, serialized)
    return c.json({ profile: serialized }, 201)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

authRoutes.post('/logout', (c) => {
  try {
    clearSessionCookie(c)
    return new Response(null, { status: 204 })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
