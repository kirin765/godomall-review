import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

const SESSION_COOKIE = 'godo_sess';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간 — godomall 장기토큰은 1:1(재발급 시 이전 것 무효)이라 재실행 기준
const SECRET = process.env.GODOMALL_SESSION_SECRET || process.env.GODOMALL_SECRET_KEY || 'dev-only-secret';

export type Session = { mallNo: number; accessToken: string };

/**
 * 세션 = 서명된 쿠키에 mallNo + 장기토큰을 담는다(쿠키를 속여 남의 몰을 여는 걸 막기 위해 HMAC).
 * godomall 장기토큰은 몰당 1:1이라 DB 저장이 오히려 복잡해진다(재실행=신규 토큰=기존 것 무효).
 * 토큰은 httpOnly 쿠키에 있으므로 서버 저장소가 필요 없다.
 */
export function issueSession(mallNo: number, accessToken: string): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ mallNo, token: accessToken, exp: expiry })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function sessionCookie(mallNo: number, accessToken: string) {
  const value = issueSession(mallNo, accessToken);
  return { name: SESSION_COOKIE, value, httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: SESSION_TTL_MS / 1000, path: '/' };
}

/** 세션 쿠키를 검증해 { mallNo, accessToken }를 돌려준다. 어디서도 쿼리의 mall 식별자를 믿지 않는다. */
export async function sessionMall(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let data: { mallNo: number; token: string; exp: number };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!data.mallNo || !data.token || Number(data.exp) < Date.now()) return null;
  return { mallNo: data.mallNo, accessToken: data.token };
}
