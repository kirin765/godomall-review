const SYSTEM_KEY = process.env.GODOMALL_SYSTEM_KEY || '';
const SECRET_KEY = process.env.GODOMALL_SECRET_KEY || '';
const REDIRECT_URI = process.env.GODOMALL_REDIRECT_URI || '';
export const APP_NO = Number(process.env.GODOMALL_APP_NO || '0');

/**
 * 고도몰 server API 베이스. 운영은 프록시(godo-proxy, egress = 등록 IP 218.237.176.17)를 가리킨다.
 * 로컬 개발은 홈 네트워크에서 직접(동일 공인 IP) 호출하므로 기본값 = 원본.
 * 장기토큰(100년)은 앱에 등록된 IP에서만 server API 호출이 가능하다(API 스펙 원문).
 */
export const API_BASE = process.env.GODO_API_BASE || 'https://server-api.godomall.com';

export type MallProfile = {
  mallNo: number;
  mallId: string;
  mallName: string;
  adminId: string;
  adminName: string;
};

type TokenResponse = {
  token_type: string;
  access_token: string;
  expire_in: string;
  refresh_token?: string | null;
  issued_at: string;
  scopes: string[];
};

/** 모든 server API에 공통으로 붙는 헤더. mall 스펙 예제는 Version 1.1, workspace(auth/me)는 1.0. */
export function authHeaders(token?: string, version = '1.1'): Record<string, string> {
  const h: Record<string, string> = { systemKey: SYSTEM_KEY, Version: version, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (process.env.GODO_PROXY_TOKEN) h['X-Proxy-Token'] = process.env.GODO_PROXY_TOKEN;
  return h;
}

/** authorizationCode로 장기토큰(100년) 발급. redirect_uri는 앱 등록 시 입력한 값과 정확히 일치해야 한다. */
export async function exchangeLongLived(code: string): Promise<{ access_token: string; expire_in: string }> {
  const res = await fetch(`${API_BASE}/auth/token/long-lived`, {
    method: 'POST',
    headers: authHeaders(undefined, '1.0'),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: SYSTEM_KEY,
      redirect_uri: REDIRECT_URI,
      code,
      client_secret: SECRET_KEY,
    }),
  });
  if (!res.ok) throw new Error(`godomall token ${res.status}: ${await res.text()}`);
  const t = (await res.json()) as TokenResponse;
  return { access_token: t.access_token, expire_in: t.expire_in };
}

/** 토큰을 발급한 몰/어드민 정보. 토큰이 곧 몰의 정체다. */
export async function getMallProfile(token: string): Promise<MallProfile> {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders(token, '1.0') });
  if (!res.ok) throw new Error(`auth/me ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return {
    mallNo: d.mall.mallNo,
    mallId: d.mall.mallId,
    mallName: d.mall.mallName,
    adminId: d.id,
    adminName: d.name,
  };
}

export type Goods = { sno: number; name: string };

export async function listGoods(token: string, page = 1, pageSize = 1000): Promise<{ totalCount: number; contents: Goods[] }> {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`${API_BASE}/goods?${q}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`goods ${res.status}: ${await res.text()}`);
  return res.json();
}

export type ExternalReview = {
  writerName: string;
  password: string;
  subject: string;
  content: string;
  reviewRating: number;
  goodsSno: number;
  externalSiteName: string;
  externalSiteUrl: string;
  externalSiteDateTime: string | null;
  naverReviewFlag: 'Y' | 'N';
  secretFlag: 'Y' | 'N';
};

/** 외부 상품 리뷰 일괄 등록(최대 100개). godomall이 공식 제공하는 리뷰 이전 엔드포인트. */
export async function importReviews(token: string, reviews: ExternalReview[]): Promise<{ success: number; fail: number; failMessage: string[] }> {
  const res = await fetch(`${API_BASE}/boards/external/goodsreviews/articles/bulk`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ reviews }),
  });
  if (!res.ok) throw new Error(`bulk ${res.status}: ${await res.text()}`);
  return res.json();
}
