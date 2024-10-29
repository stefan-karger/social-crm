import { sha256 } from "@oslojs/crypto/sha2"
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from "@oslojs/encoding"
import { cache } from "@solidjs/router"
import { eq } from "drizzle-orm"
import { useSession } from "vinxi/http"

import { serverEnv } from "~/env/server"
import { db, sessionTable, userTable } from "~/lib/db"
import type { Session, User } from "~/lib/db"

export type SessionValidationResult =
  | { session: Session; user: User }
  | { session: null; user: null }

export function generateSessionToken(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  const token = encodeBase32LowerCaseNoPadding(bytes)
  return token
}

export async function createSession(token: string, userId: number): Promise<Session> {
  const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
  const session: Session = {
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
  }
  await db.insert(sessionTable).values(session)
  return session
}

export async function validateSessionToken(token: string): Promise<SessionValidationResult> {
  const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
  const result = await db
    .select({ user: userTable, session: sessionTable })
    .from(sessionTable)
    .innerJoin(userTable, eq(sessionTable.userId, userTable.id))
    .where(eq(sessionTable.id, sessionId))
  if (result.length < 1) {
    return { session: null, user: null }
  }
  const { user, session } = result[0]
  if (Date.now() >= session.expiresAt.getTime()) {
    await db.delete(sessionTable).where(eq(sessionTable.id, session.id))
    return { session: null, user: null }
  }
  if (Date.now() >= session.expiresAt.getTime() - 1000 * 60 * 60 * 24 * 15) {
    session.expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    await db
      .update(sessionTable)
      .set({
        expiresAt: session.expiresAt
      })
      .where(eq(sessionTable.id, session.id))
  }
  return { session, user }
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(sessionTable).where(eq(sessionTable.id, sessionId))
}

export async function setSessionTokenCookie(token: string, expiresAt: Date) {
  const cookie = await useSession({
    password: serverEnv.SESSION_SECRET,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: serverEnv.NODE_ENV === "production",
      expires: expiresAt,
      path: "/"
    }
  })
  await cookie.update((data) => {
    data.token = token
  })
}

export async function deleteSessionTokenCookie() {
  const cookie = await useSession({
    password: serverEnv.SESSION_SECRET,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: serverEnv.NODE_ENV === "production",
      maxAge: 0,
      path: "/"
    }
  })
  await cookie.update((data) => {
    data.token = undefined
  })
}

export const getCurrentSession = cache(async () => {
  const session = await useSession({ password: serverEnv.SESSION_SECRET })
  const token = session.data.token
  if (token === null) {
    return { session: null, user: null }
  }
  const result = await validateSessionToken(token)
  return result
}, "getCurrentSession")
