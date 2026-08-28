import { NextRequest, NextResponse } from 'next/server';
import { clearEntitlement, deleteToken } from '@/lib/entitlement';
import { APP_NO } from '@/lib/godomall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 공통 웹훅 — 앱 설치/삭제(CHANGE_APP_STATUS).
 * payload: { eventType, currentStatus: "ACTIVE"|"DELETED", appNo, appInstalledNo, mallNo, shopNo, solutionType }
 *
 * 무료 20건은 "쇼핑몰(몰 ID)당 평생 한도"다.
 * DELETED 시 사용량을 리셋하지 않는다 — 삭제→재설치로 무료 한도가 되살아나면
 * 심사/운영상 "20건 넘게 등록 가능"으로 오인될 수 있기 때문(심사 문의 확인됨).
 * DELETED 시 entitlement 캐시·몰 토큰만 정리한다(결제 기록은 환불/정산 근거로 유지).
 * ⚠️ godomall 웹훅은 문서에 서명 헤더가 없어, appNo + solutionType 외에는 위조 검증 수단이 없다.
 * 항상 200을 돌려 재전송 스톰을 막는다.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const appNo = Number(body.appNo);
  const solutionType = String(body.solutionType || '');
  const eventType = String(body.eventType || '');

  // 진단: 인앱결제 설정 후 워크스페이스가 결제/구독 관련 새 이벤트를 이 공통 웹훅으로 보내는지 확인.
  // (운영 로그에서 "webhook event" 검색)
  if (eventType !== 'CHANGE_APP_STATUS') {
    console.log('webhook event', JSON.stringify(body).slice(0, 1000));
  }
  if (appNo !== APP_NO || solutionType !== 'GODO') {
    return NextResponse.json({ ok: true });
  }

  const mallNo = Number(body.mallNo || body.shopNo);
  const status = String(body.currentStatus || '');
  if (mallNo > 0 && status === 'DELETED') {
    await clearEntitlement(mallNo);
    await deleteToken(mallNo);
  } else if (mallNo > 0 && status === 'ACTIVE') {
    // 설치/재실행 시 상태 캐시를 비워 다음 접근에서 workspace 상태를 새로 판정하게 한다.
    await clearEntitlement(mallNo);
  }

  return NextResponse.json({ ok: true });
}
