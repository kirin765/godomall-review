import { Paddle, Environment } from '@paddle/paddle-node-sdk';

/**
 * Paddle(머천트 오브 레코드) 정기결제 연동.
 * - godomall 인앱결제는 개발자가 직접 수금하므로, Paddle이 9,900원/월 구독을 대신 징수한다.
 * - Paddle 웹훅 검증 → 유료 구독이면 godomall /app-installed/extend(CHARGE)로 만료일 연장.
 *
 * 환경변수:
 *   PADDLE_API_KEY      서버 전용 Bearer API 키 (test/live 구분은 PADDLE_ENVIRONMENT)
 *   PADDLE_ENVIRONMENT  'sandbox' | 'production'
 *   PADDLE_PRICE_ID     월 9,900원 구독 price_id (대시보드에서 생성)
 *   PADDLE_WEBHOOK_SECRET 웹훅 서명 검증 시크릿 (pdl_ntfset_...) — 알림 대상별 고유
 */
const API_KEY = process.env.PADDLE_API_KEY || '';
const ENV: Environment = process.env.PADDLE_ENVIRONMENT === 'production' ? Environment.production : Environment.sandbox;
export const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID || '';
export const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';

export const PRICE = process.env.PADDLE_PRICE_AMOUNT || '9,900';
export const CURRENCY = 'KRW';

let _paddle: Paddle | null = null;
export function getPaddle(): Paddle {
  if (!API_KEY) throw new Error('PADDLE_API_KEY not set');
  if (!_paddle) _paddle = new Paddle(API_KEY, { environment: ENV });
  return _paddle;
}

/** Paddle.js를 브라우저에서 쓸 client-side token을 서버에서 발급한다. */
export async function createClientToken(name: string): Promise<string> {
  const paddle = getPaddle();
  const token = await paddle.clientTokens.create({ name });
  return token.token;
}
