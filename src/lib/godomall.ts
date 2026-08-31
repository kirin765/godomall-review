const SYSTEM_KEY = process.env.GODOMALL_SYSTEM_KEY || '';
const SECRET_KEY = process.env.GODOMALL_SECRET_KEY || '';
export const APP_NO = Number(process.env.GODOMALL_APP_NO || '0');

/**
 * 고도몰 server API 베이스. 운영은 프록시(godo-proxy, cloudflared)를 가리키며 프록시의 egress IP가
 * 개발자센터 "IP 설정"에 등록돼 있어야 한다. 로컬 개발은 홈 네트워크에서 직접 호출하므로 기본값 = 원본.
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

/**
 * authorizationCode로 장기토큰(100년) 발급.
 * redirect_uri는 고도몰 개발자센터 "redirect URI" 필드에 등록한 값과 정확히 일치해야 한다(앱 URI와 다름).
 * 불일치 시 403 A0003 "Redirect url 이 잘못되었습니다".
 */
export async function exchangeLongLived(code: string, redirectUri: string): Promise<{ access_token: string; expire_in: string }> {
  const res = await fetch(`${API_BASE}/auth/token/long-lived`, {
    method: 'POST',
    headers: authHeaders(undefined, '1.0'),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: SYSTEM_KEY,
      redirect_uri: redirectUri,
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
  attachmentUrls?: string[];
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

/** 외부 리뷰로 옮긴 글이 실제 상품 후기 게시판(goodsreview)의 어느 글 번호인지 알아내는 조회. */
export type GoodsReviewArticle = {
  sno: number;
  writerName: string;
  subject: string;
  content: string;
  goodsSno: number;
  rating: number | null;
  attachments?: { url: string }[] | null;
  registerDateTime: string | null;
};

/**
 * 상품 후기 게시글 리스트 조회. 등록일(registerDateTime) 구간 필터만 지원하고
 * 상품·작성자 필터는 없다 → 옮긴 글을 다시 찾으려면 시간 창으로 내려받아 대조한다.
 */
export async function listGoodsReviewArticles(
  token: string,
  opts: { registerStartDate?: string; registerEndDate?: string; page?: number; pageSize?: number } = {},
): Promise<{ totalCount: number; contents: GoodsReviewArticle[] }> {
  const q = new URLSearchParams();
  if (opts.registerStartDate) q.set('registerStartDate', opts.registerStartDate);
  if (opts.registerEndDate) q.set('registerEndDate', opts.registerEndDate);
  if (opts.page) q.set('page', String(opts.page));
  if (opts.pageSize) q.set('pageSize', String(opts.pageSize));
  const res = await fetch(`${API_BASE}/boards/goodsreview/articles?${q}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`goodsreview articles ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 게시글 삭제(204). 상품 후기는 boardId='goodsreview'. 실측으로 204/404 동작을 확인할 것. */
export async function deleteBoardArticle(token: string, boardId: string, articleSno: number): Promise<void> {
  const res = await fetch(`${API_BASE}/boards/${boardId}/articles/${articleSno}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`delete article ${res.status}: ${await res.text()}`);
}
