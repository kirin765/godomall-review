/**
 * 워크스페이스(앱스토어) 인앱결제 API 클라이언트.
 *
 * NHN 워크스페이스 server API (https://server-api.e-ncp.com, spec: workspace-server-public.yml)
 *  - GET /app-installed/status : 앱 사용 상태 조회 (ACTIVE / EXPIRED / DELETED + 만료일시)
 *  - PUT /app-installed/extend : 인앱 결제 완료 시 앱 만료일 설정/연장
 *
 * 인증: 헤더 systemKey(=GODOMALL_SYSTEM_KEY) + Authorization: Bearer <몰 장기토큰> + Version: 1.0
 * 몰 장기토큰은 고도몰 OAuth(code)로 발급된 토큰(server-api.godomall.com/auth/token/long-lived)과
 * 동일 계열로, 워크스페이스가 고도몰/샵바이를 함께 인증한다.
 *
 * ⚠️ 앱이 아직 "판매앱+인앱결제"로 전환되지 않았거나 토큰이 workspace에서 인정되지 않으면
 *    status 조회가 401/404로 실패한다 → UNKNOWN(무료 폴백)으로 처리해 기존 무료 20건 동작을 깨지 않게 한다.
 */

const WORKSPACE_API = process.env.GODO_WORKSPACE_API || 'https://server-api.e-ncp.com';
const SYSTEM_KEY = process.env.GODOMALL_SYSTEM_KEY || '';
const VERSION = '1.0';
const PROXY_TOKEN = process.env.GODO_PROXY_TOKEN || '';

/**
 * 공통 헤더. 운영은 godo-proxy(egress IP 등록)를 경유하므로,
 * GODO_WORKSPACE_API=https://godo-proxy.sajangbu.com 일 때 X-Proxy-Token을 함께 보낸다.
 */
function wsHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    systemKey: SYSTEM_KEY,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  if (PROXY_TOKEN) h['X-Proxy-Token'] = PROXY_TOKEN;
  return h;
}

export type AppStatusKind = 'ACTIVE' | 'EXPIRED' | 'DELETED';

export type AppStatus =
  | { kind: 'ACTIVE' | 'EXPIRED' | 'DELETED'; expireDateTime?: string }
  | { kind: 'UNKNOWN'; reason?: string };

/** GET /app-installed/status — 실패/미인증은 UNKNOWN으로 폴백(무료 유지) */
export async function fetchAppStatus(accessToken: string): Promise<AppStatus> {
  try {
    const res = await fetch(`${WORKSPACE_API}/app-installed/status`, {
      headers: wsHeaders(accessToken),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { kind: 'UNKNOWN', reason: `status ${res.status}` };
    }
    const d = (await res.json()) as { currentStatus?: string; expireDateTime?: string };
    const kind = d.currentStatus;
    if (kind === 'ACTIVE' || kind === 'EXPIRED' || kind === 'DELETED') {
      return { kind, expireDateTime: d.expireDateTime ?? undefined };
    }
    return { kind: 'UNKNOWN', reason: `unexpected status ${String(kind)}` };
  } catch (e) {
    return { kind: 'UNKNOWN', reason: (e as Error).message.slice(0, 120) };
  }
}

export type ExtendParams = {
  orderNo?: string;
  /** 새 만료일시 "yyyy-MM-dd HH:mm:ss" (지정 없으면 now + GODO_PAID_MONTHS) */
  requestDateTime?: string;
  /** workspace 스펙: TRIAL(무료 체험) | CHARGE(인앱 유료결제). 'PAID'는 예전 코드 호환용 별칭. */
  paymentType: 'TRIAL' | 'CHARGE';
  price: number;
};

/** workspace `paymentType` 정규화 — 예전 코드에서 쓰던 'PAID'를 스펙의 'CHARGE'로 매핑한다. */
export function normalizePaymentType(raw: unknown): 'TRIAL' | 'CHARGE' {
  return String(raw ?? '') === 'TRIAL' ? 'TRIAL' : 'CHARGE';
}

/** PUT /app-installed/extend — 204 성공. 실패 시 throw(호출자가 기록). */
export async function extendAppStatus(accessToken: string, params: ExtendParams): Promise<void> {
  const res = await fetch(`${WORKSPACE_API}/app-installed/extend`, {
    method: 'PUT',
    headers: wsHeaders(accessToken),
    body: JSON.stringify({
      orderNo: params.orderNo ?? '',
      requestDateTime: params.requestDateTime,
      paymentType: params.paymentType,
      price: params.price,
    }),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`extend ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** 결제/만료 주기 상수 — 판매정보(인앱결제 가격 정보)와 일치시킬 것 */
/**
 * 리뷰이사 플러스 요금 — 9,900원(부가세 포함). 공급가액 9,000원 + 부가세 900원.
 * 몰이 납부하는 총액이므로 워크스페이스 extend의 price로 그대로 전달한다.
 */
export const PAID_PRICE = Number(process.env.GODO_PAID_PRICE || '9900');
export const PAID_MONTHS = Number(process.env.GODO_PAID_MONTHS || '1');

/**
 * 수동 계좌이체 결제 안내 — 앱스토어에 가격·결제 폼이 없어 셀러↔몰 직거래로 수신한다
 * (2026-09-02 사용자 확정: 결제 방식 = 수동 계좌이체, 9,900원 부가세 포함).
 * 관리 화면 plan에 그대로 내려 고객에게 계좌이체 절차를 안내한다.
 */
export const PAYMENT_INFO = {
  method: 'bank' as const,
  bank: '토스뱅크',
  account: '1002-5844-8101',
  holder: '온누리문방구',
  /** 부가세 포함 여부 — true면 PAID_PRICE가 총액(세금 포함) */
  vatIncluded: true,
  /** 입금 후 연락처 — 이곳으로 입금자명·몰을 알려주면 수동으로 전환한다 */
  contactEmail: process.env.SUPPORT_EMAIL || 'kwan765@naver.com',
} as const;

export type PaymentInfo = typeof PAYMENT_INFO;

/** "yyyy-MM-dd HH:mm:ss" → Date */
export function parseWorkspaceDate(s?: string): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m.map(Number);
  return new Date(y, mo - 1, d, hh, mi, ss);
}

/** now + months 뒤의 만료일시 문자열(workspace 포맷) */
export function expiryAfterMonths(months: number, from = new Date()): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}