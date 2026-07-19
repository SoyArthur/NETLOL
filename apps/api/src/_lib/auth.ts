// Hono-native auth helpers — mirror src/lib/auth.ts but read cookies from
// Hono's context (no next/headers dependency).
//
// Session storage is shared with the Next.js app via the globalThis Map
// hoisted in src/lib/auth.ts so a session cookie set by the Next.js signup
// route is also valid here (and vice-versa) when both run in the same
// process. In a split deploy, sessions are scoped to whichever backend
// wrote them — the frontend uses NEXT_PUBLIC_API_URL to pick one.
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db } from '@/lib/db'
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSession,
} from '@/lib/auth'
import { serializeProfile } from '@/app/api/_lib/serialize'
import type { Profile } from '@/types'

const SESSION_TTL_DAYS = 30

export type Vars = {
  profile: Profile | null
}

// Mirror getCurrentProfile from src/lib/auth.ts but pull the cookie from
// Hono's context instead of next/headers.
export async function getCurrentProfile(c: Context): Promise<Profile | null> {
  const token = getCookie(c, SESSION_COOKIE)
  const session = getSession(token)
  if (!session) return null
  const p = await db.profile.findUnique({ where: { id: session.profileId } })
  if (!p) return null
  // Read wallet fields via raw SQL — the cached Prisma client may be running
  // with an older schema that doesn't know about walletAddress/walletChain.
  const wallet = await db
    .$queryRaw<{ walletAddress: string | null; walletChain: string | null }[]>`
      SELECT walletAddress, walletChain FROM Profile WHERE id = ${p.id}
    `.then((rows) => rows[0] ?? null)
    .catch(() => null)
  return {
    id: p.id,
    email: p.email,
    username: p.username,
    avatarUrl: p.avatarUrl,
    plan: p.plan as Profile['plan'],
    planExpiresAt: p.planExpiresAt?.toISOString() ?? null,
    vetoTimeoutSeconds: p.vetoTimeoutSeconds,
    walletAddress: wallet?.walletAddress ?? null,
    walletChain: (wallet?.walletChain ?? 'solana') as Profile['walletChain'],
    createdAt: p.createdAt.toISOString(),
  }
}

// Sets the session cookie on the response. Mirrors setSessionCookie in
// src/lib/auth.ts. Returns the token so the caller can also stash it
// elsewhere if needed (e.g. redirect query).
export function setSessionCookie(c: Context, profile: Profile): string {
  const token = createSession(profile)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    secure: process.env.NODE_ENV === 'production',
  })
  return token
}

export function clearSessionCookie(c: Context): void {
  const token = getCookie(c, SESSION_COOKIE)
  destroySession(token)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

// Middleware that resolves the current profile (or null) and attaches it to
// c.var.profile. Routes that need auth call `requireProfile(c)`.
export const authMiddleware: MiddlewareHandler<{ Variables: Vars }> = async (
  c,
  next,
) => {
  try {
    const profile = await getCurrentProfile(c)
    c.set('profile', profile)
  } catch {
    c.set('profile', null)
  }
  await next()
}

// Returns the profile from context (set by authMiddleware) — throws a
// 401-shaped error that the route can `return` if there is no session.
export function getProfile(c: Context): Profile | null {
  return c.get('profile') ?? null
}

// Returns the profile or a 401 Response that the route can return.
export function requireProfile(c: Context): Profile {
  const profile = getProfile(c)
  if (!profile) {
    throw new AuthError('unauthorized')
  }
  return profile
}

export class AuthError extends Error {
  status = 401
  constructor(message: string) {
    super(message)
  }
}

// Convenience helper for serializing a Prisma profile row.
export { serializeProfile }
