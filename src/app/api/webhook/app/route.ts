import { NextRequest, NextResponse } from 'next/server';
import { resetUsage } from '@/lib/quota';
import { APP_NO } from '@/lib/godomall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 공통 웹훅 — 앱 설치/삭제(CHANGE_APP_STATUS).
 * payload: { eventType, currentStatus: "ACTIVE"|"DELETED", appNo, appInstalledNo, mallNo, shopNo, solutionType }
 *
 * DELETED 시 사용량을 지운다(재설치하면 무료 한도 재시작).
 * 토큰은 세션 쿠키(서버 저장 없음)라 삭제 대상이 없다 — 재설치가 낡은 서버 토큰에 막히는 문제가 구조적으로 없다.
 * ⚠️ godomall 웹훅은 문서에 서명 헤더가 없어, appNo + solutionType 외에는 위조 검증 수단이 없다.
 * 본인 몰 테스트 단계에선 수용하되, 판매앱 전환 전에 godomall에 검증 수단(시크릿 등)을 확인한다.
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
  if (appNo !== APP_NO || solutionType !== 'GODO') {
    return NextResponse.json({ ok: true });
  }

  if (body.eventType === 'CHANGE_APP_STATUS' && body.currentStatus === 'DELETED') {
    const mallNo = Number(body.mallNo);
    if (mallNo > 0) await resetUsage(mallNo);
  }

  return NextResponse.json({ ok: true });
}
