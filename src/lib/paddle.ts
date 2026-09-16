/**
 * Paddle Billing 클라이언트 — 웹훅 서명 검증 + 서버 API 조회.
 *
 * 결제 수신은 Paddle Billing의 호스티드 체크아웃(Paddle.js overlay)으로 받고,
 * 결제 완료/구독 갱신은 웹훅(`/api/payment/paddle/webhook`)으로 통보받아
 * `app_subscriptions`에 기록 → 몰을 무제한(plus)으로 전환한다.
 *
 * 필요한 환경변수 (`PADDLE_ENV` 미설정 시 sandbox):
 *  - PADDLE_ENV            : sandbox | production
 *  - PADDLE_CLIENT_TOKEN   : Paddle.js용 client-side 토큰 (공개 가능, 관리 화면에 내려감)
 *  - PADDLE_PRICE_ID       : 리뷰이사 플러스 가격 ID (pri_…)
 *  - PADDLE_WEBHOOK_SECRET : 웹훅 서명 검증 시크릿 (pdl_ntfset_…, 서버 전용)
 *  - PADDLE_API_KEY        : 서버 API 키 (pdl_live_…/pdl_sdbx_…, 서버 전용)
 *  - PADDLE_CURRENCY       : 표시 통화 (기본 KRW)
 *
 * ⚠️ 이 파일은 서버 코드에서만 import 한다. 클라이언트로 내보내는 값은 PADDLE_CONFIG의
 *    공개 가능 필드(clientToken·priceId 등)뿐이며, API 키·웹훅 시크릿은 절대 노출하지 않는다.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type PaddleEnv = 'sandbox' | 'production';

/**
 * 환경 — `PADDLE_ENV` 또는 기존 Vercel에 등록된 `PADDLE_ENVIRONMENT`를 읽는다.
 * 'production'이 아니면 sandbox로 안전 폴백한다.
 */
export const PADDLE_ENV: PaddleEnv =
  (process.env.PADDLE_ENV || process.env.PADDLE_ENVIRONMENT) === 'production' ? 'production' : 'sandbox';
export const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || '';
export const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID || '';
export const PADDLE_CURRENCY = (process.env.PADDLE_CURRENCY || 'KRW').toUpperCase();

/** 서버 전용 — 절대 클라이언트로 내보내지 않는다. */
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';

const PADDLE_API_BASE =
  PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

/** 서명 타임스탬프 허용 오차(초). 재전송 공격 방지 — 기본 5분. */
const SIGNATURE_TOLERANCE_SEC = Number(process.env.PADDLE_WEBHOOK_TOLERANCE_SEC || '300');

/**
 * 관리 화면에 내려보내는 결제 설정 (공개 가능 필드만).
 * clientToken·priceId가 없으면 enabled=false → 화면은 문의 안내로 폴백한다.
 */
export const PADDLE_CONFIG = {
  method: 'paddle' as const,
  enabled: !!(PADDLE_CLIENT_TOKEN && PADDLE_PRICE_ID),
  env: PADDLE_ENV,
  clientToken: PADDLE_CLIENT_TOKEN,
  priceId: PADDLE_PRICE_ID,
  currency: PADDLE_CURRENCY,
  vatIncluded: true,
  contactEmail: process.env.SUPPORT_EMAIL || 'kwan765@naver.com',
} as const;

export type PaddleConfig = typeof PADDLE_CONFIG;

/**
 * Paddle 웹훅 서명 검증.
 * 헤더 형식 `ts=<unix>;h1=<hex>`, 서명은 HMAC-SHA256(`${ts}:${rawBody}`) hex.
 * 서명 로테이션 대비 h1이 여러 개일 수 있어 하나라도 일치하면 통과한다.
 * 반드시 raw body(파싱 전 문자열)를 넘긴다.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!PADDLE_WEBHOOK_SECRET || !header) return false;

  let ts = 0;
  const hashes: string[] = [];
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const val = part.slice(idx + 1);
    if (key === 'ts') ts = Number(val);
    else if (key === 'h1' && val) hashes.push(val);
  }
  if (!ts || !hashes.length) return false;
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return false;

  const expected = Buffer.from(
    createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(`${ts}:${rawBody}`).digest('hex'),
  );
  return hashes.some((h) => {
    const got = Buffer.from(h);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export type PaddleSubscription = {
  id?: string;
  status?: string;
  customer_id?: string;
  custom_data?: Record<string, unknown> | null;
  current_billing_period?: { starts_at?: string | null; ends_at?: string | null } | null;
};

/** GET /subscriptions/{id} — 결제 시점의 구독 기간 종료일을 확인한다. 실패는 null(호출자가 폴백). */
export async function fetchPaddleSubscription(id: string): Promise<PaddleSubscription | null> {
  if (!PADDLE_API_KEY) return null;
  try {
    const res = await fetch(`${PADDLE_API_BASE}/subscriptions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${PADDLE_API_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { data?: PaddleSubscription };
    return d.data ?? null;
  } catch {
    return null;
  }
}

/** Paddle의 custom_data.mallNo → 숫자 몰 번호. 없거나 이상하면 0. */
export function mallNoFromCustomData(customData: unknown): number {
  if (!customData || typeof customData !== 'object') return 0;
  const raw = (customData as Record<string, unknown>).mallNo;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
