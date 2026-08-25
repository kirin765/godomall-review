import { NextRequest, NextResponse } from 'next/server';
import { exchangeLongLived, getMallProfile, extendAppInstall } from '@/lib/godomall';
import { sessionCookie } from '@/lib/launch';
import { saveInstall } from '@/lib/install';
import { TRIAL_DAYS } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * godomall 쇼핑몰 관리자가 앱을 실행하면 앱 URI(루트)가
 * `?code={authorizationCode}&solution=godo&adminUrl=...`로 열린다.
 * code를 장기토큰으로 교환하고 세션(서명 쿠키)에 실어 /admin으로 보낸다.
 * code는 1회용이라 실패(이미 사용됨) 시 재실행하라는 안내로 끝낸다.
 *
 * 최초 설치 시 TRIAL 3일을 godomall /app-installed/extend로 열어준다(best-effort).
 * 실패해도 설치를 막지 않는다 — godomall의 기본 만료일로도 동작하며, 못 쓰면
 * 나중에 ext/review에서 502로 드러난다.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const solution = req.nextUrl.searchParams.get('solution');

  if (!code || (solution !== 'godomall' && solution !== 'godo')) {
    return NextResponse.json({ error: 'invalid launch' }, { status: 400 });
  }

  try {
    const { access_token } = await exchangeLongLived(code);
    const profile = await getMallProfile(access_token);

    // Paddle 웹훅이 서버에서 /app-installed/extend를 부를 때 쓸 토큰을 저장한다.
    // (godomall 1:1 장기토큰 — 재설치 시 덮어써 최신본 유지)
    await saveInstall(profile.mallNo, access_token).catch((e) =>
      console.warn(`[godomall] install token save failed: ${(e as Error).message.slice(0, 120)}`));

    // 최초 1회 설치 시에만 의미: godomall이 이미 연장이라도 3일을 향해 재설정되진 않는다
    // (extend는 남은 시간을 무시하고 덮어쓰므로, 반복 재실행이 3일을 계속 리셋하지 않도록
    //  성공 시에만 1회 시도하되 실패는 무시한다).
    await extendAppInstall(access_token, {
      orderNo: `godo_trial_${profile.mallNo}_${Date.now()}`,
      requestDateTime: new Date(Date.now() + TRIAL_DAYS * 86400e3 + 9 * 3600e3)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
      paymentType: 'TRIAL',
      price: 0,
    }).catch((e) => {
      console.warn(`[godomall] trial extend skipped: ${(e as Error).message.slice(0, 120)}`);
    });

    const res = NextResponse.redirect(new URL('/admin', req.url));
    res.cookies.set(sessionCookie(profile.mallNo, access_token));
    return res;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    return NextResponse.json({ error: `token exchange failed: ${msg}` }, { status: 502 });
  }
}
