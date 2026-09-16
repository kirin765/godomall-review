/**
 * 유료 전환 공통 처리 — 외부 결제(Paddle) 웹훅과 수동 활성화가 함께 쓴다.
 *
 * 순서: (1) 같은 주문번호가 이미 기록됐으면 멱등 스킵 (2) 몰 토큰이 있으면 workspace 만료일 연장
 *       (3) `app_subscriptions` 원장 기록 (4) entitlement 캐시를 ACTIVE로 선반영.
 *
 * 원장 기록(app_subscriptions)이 paid 판정의 근거다. workspace 연장이 실패해도
 * 결제는 이미 이뤄진 것이므로 외부 결제 경로에서는 기록을 우선한다(requireWorkspace=false).
 */
import {
  findSubscriptionByOrder,
  getToken,
  markEntitlement,
  recordSubscription,
} from '@/lib/entitlement';
import { extendAppStatus, formatWorkspaceDate, normalizePaymentType, type ExtendParams } from '@/lib/payment';

export type WorkspaceResult = 'extended' | 'skipped' | 'failed';

export type ActivateResult = {
  ok: boolean;
  /** 원장에 새로 기록했는지 (멱등 스킵이면 false) */
  recorded: boolean;
  workspace: WorkspaceResult;
  /** 같은 주문번호로 이미 처리돼 건너뛴 경우 true (웹훅 재전송) */
  duplicate: boolean;
  error?: string;
};

export async function activatePaid(opts: {
  mallNo: number;
  untilTs: Date;
  price: number;
  paymentType?: 'TRIAL' | 'CHARGE';
  orderNo?: string;
  /** workspace 연장 실패를 치명 오류로 볼지. 수동 활성화=true, 외부 결제=false */
  requireWorkspace?: boolean;
}): Promise<ActivateResult> {
  const { mallNo, untilTs, price, orderNo } = opts;
  const paymentType = normalizePaymentType(opts.paymentType ?? 'CHARGE');

  if (orderNo && (await findSubscriptionByOrder(mallNo, orderNo))) {
    return { ok: true, recorded: false, workspace: 'skipped', duplicate: true };
  }

  let workspace: WorkspaceResult = 'skipped';
  const token = await getToken(mallNo);
  if (token) {
    const params: ExtendParams = {
      orderNo,
      requestDateTime: formatWorkspaceDate(untilTs),
      paymentType,
      price,
    };
    try {
      await extendAppStatus(token, params);
      workspace = 'extended';
    } catch (e) {
      workspace = 'failed';
      console.error('activatePaid: workspace extend 실패', {
        mallNo: String(mallNo),
        orderNo: orderNo ?? '',
        error: (e as Error).message.slice(0, 200),
      });
      if (opts.requireWorkspace) {
        return { ok: false, recorded: false, workspace, duplicate: false, error: (e as Error).message.slice(0, 200) };
      }
    }
  } else if (opts.requireWorkspace) {
    return { ok: false, recorded: false, workspace, duplicate: false, error: 'no token for mall' };
  }

  const recorded = await recordSubscription({ mallNo, orderNo, paymentType, price, untilTs });
  if (!recorded && process.env.DATABASE_URL) {
    console.error('activatePaid: 구독 기록 실패 — 활성화가 안 된 채 성공으로 보일 수 있음', {
      mallNo: String(mallNo),
      orderNo: orderNo ?? '',
    });
    return { ok: false, recorded: false, workspace, duplicate: false, error: '구독 기록 실패 — DB 확인 필요' };
  }
  await markEntitlement(mallNo, 'ACTIVE', untilTs);
  return { ok: true, recorded, workspace, duplicate: false };
}
