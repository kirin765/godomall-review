import { NextRequest, NextResponse } from 'next/server';
import { exchangeLongLived, getMallProfile } from '@/lib/godomall';
import { sessionCookie } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * godomall 쇼핑몰 관리자가 앱을 실행하면 앱 URI(루트)가
 * `?code={authorizationCode}&solution=godomall`로 열린다.
 * code를 장기토큰으로 교환하고 세션(서명 쿠키)에 실어 /admin으로 보낸다.
 * code는 1회용이라 실패(이미 사용됨) 시 재실행하라는 안내로 끝낸다.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const solution = req.nextUrl.searchParams.get('solution');

  if (!code || solution !== 'godomall') {
    return NextResponse.json({ error: 'invalid launch' }, { status: 400 });
  }

  try {
    const { access_token } = await exchangeLongLived(code);
    const profile = await getMallProfile(access_token);

    const res = NextResponse.redirect(new URL('/admin', req.url));
    res.cookies.set(sessionCookie(profile.mallNo, access_token));
    return res;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    return NextResponse.json({ error: `token exchange failed: ${msg}` }, { status: 502 });
  }
}
