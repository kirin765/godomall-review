import { NextRequest, NextResponse } from 'next/server';
import { exchangeLongLived, getMallProfile } from '@/lib/godomall';
import { sessionCookie } from '@/lib/launch';
import { saveToken } from '@/lib/entitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * godomall 쇼핑몰 관리자가 앱을 실행하면 앱 URI(루트)가
 * `?code={authorizationCode}&solution=godo&adminUrl=...`로 열린다.
 * code를 장기토큰으로 교환하고 세션(서명 쿠키)에 실어 /admin으로 보낸다.
 * code는 1회용이라 실패(이미 사용됨) 시 재실행하라는 안내로 끝낸다.
 * 몰 장기토큰은 유료 전환 후 판매사 측 인앱결제(extend) 처리를 위해 DB에도 저장한다.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const solution = req.nextUrl.searchParams.get('solution');

  // 진단: 결제 후 앱 실행 시 어떤 파라미터가 붙어 오는지 확인 (결제 완료 시그널 실측용).
  // 운영 로그에서 검색: "launch params"
  const all: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => (all[k] = v));
  console.log('launch params', JSON.stringify(all));

  if (!code || (solution !== 'godomall' && solution !== 'godo')) {
    return NextResponse.json({ error: 'invalid launch' }, { status: 400 });
  }

  try {
    // redirect_uri는 고도몰 개발자센터 "redirect URI" 필드 등록값과 정확히 일치해야 한다(A0003).
    // 환경변수가 없으면 현재 경로(/api/auth/launch) 기준으로 만든다 — 등록 redirect URI와 같은 경로다.
    const redirectUri = process.env.GODOMALL_REDIRECT_URI || `${new URL(req.url).origin}/api/auth/launch`;
    const { access_token } = await exchangeLongLived(code, redirectUri);
    const profile = await getMallProfile(access_token);
    void saveToken(profile.mallNo, access_token); // 실패해도 로그인은 진행(무료 폴백)

    const res = NextResponse.redirect(new URL('/admin', req.url));
    res.cookies.set(sessionCookie(profile.mallNo, access_token));
    return res;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    return NextResponse.json({ error: `token exchange failed: ${msg}` }, { status: 502 });
  }
}
