import { createHash, randomUUID } from 'crypto';
import postgres from 'postgres';
import { normalizeReviewLineEndings } from './reviewImport';

// Durable, platform-scoped transfer ledger. A remote write requires a persisted claim.
// Confirmed writes deduplicate by full-file occurrence; unknown outcomes stay blocked.
import { listGoodsReviewArticles, type GoodsReviewArticle } from '@/lib/godomall';


export type ImportedReviewRow = {
  import_key: string;
  article_sno: number | null;
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
  imported_at: Date;
  /** 쇼핑몰 저장 공간 부족 등으로 사진 없이 등록된 글. */
  photo_dropped: boolean;
};

export type NewImport = {
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  images: string[];
  created_date: string | null;
  photo_dropped?: boolean;
  sourceId?: string;
  dedup_hash?: string | null;
};

/**
 * 리뷰 내용으로 중복 판정용 해시를 만든다. 같은 상품·작성자·평점·본문(옵션 포함)·이미지·
 * 작성일이면 같은 해시 → 재전송 시 게시판에 확인된 것으로 보고 건너뛴다.
 * 주의: 원장/요청 어디서든 같은 결과가 나오려면, 해시는 **보내는 값과 똑같이 정제된** 값으로
 * 만들어야 한다(writeReviews.toNewImport가 만든 값 그대로). 정제 전 원본으로 만들면
 * 재전송 간 값이 어긋나 멱등이 깨진다(cafe24-review 2464d56 교훈).
 */
type ReviewHashInput = {
  sourceId?: string;
  writer: string;
  score: number;
  content: string;
  images?: string[];
  created_date?: string | null;
};

function rawReviewHash(goodsNo: number, r: ReviewHashInput): string {
  const parts = [
    String(goodsNo),
    String(r.writer ?? ''),
    String(r.score ?? ''),
    String(r.content ?? ''),
    // 이미지 URL은 순서와 무관하게 같은 해시가 되도록 정렬한다.
    (r.images ?? []).slice().sort().join('\u0001'),
    String(r.created_date ?? ''),
  ];
  if (r.sourceId && r.sourceId !== 'occurrence:0') parts.push(r.sourceId);
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Normalize line endings so Excel exports cannot create a second identity for one review. */
export function reviewHash(goodsNo: number, r: ReviewHashInput): string {
  return rawReviewHash(goodsNo, { ...r, content: normalizeReviewLineEndings(String(r.content ?? '')) });
}

/** Recognize hashes written before line-ending normalization without rewriting old ledger rows. */
export function reviewHashAliases(goodsNo: number, r: ReviewHashInput): string[] {
  const content = normalizeReviewLineEndings(String(r.content ?? ''));
  const variants = new Set([content, content.replaceAll('\n', '\r\n')]);
  return [...new Set([
    rawReviewHash(goodsNo, r),
    ...[...variants].map((value) => rawReviewHash(goodsNo, { ...r, content: value })),
  ])];
}

export type ReviewIdentity = {
  legacyHash: string;
  occurrence: number;
  /** Hashes for the source-aware identity, including historical line endings. */
  aliases?: string[];
  /** Hashes for the content-only legacy identity, including historical line endings. */
  legacyAliases?: string[];
};

// 고도몰 server API 스펙(server-docs.godomall.com/spec/server-api.yml) 기준:
// GET /boards/goodsreview/articles 는 pageSize 기본 100, 최대 10000. 상품 후기 게시판은
// 하루에 리뷰가 수백 건이어도 대량 이관 직후엔 시간 창 안에 수천~만 건이 몰릴 수 있어
// 최대값(10000)으로 페이지를 줄여 조회 왕복을 최소화한다.
const MATCH_PAGES_MAX = 10; // 안전망: 시간 창 안 게시글이 아무리 많아도 10만 건까지만 대조한다
const MATCH_PAGE_SIZE = 10000;
const MATCH_START_MARGIN_MS = 2 * 60 * 1000; // 등록 직후 목록에 안 잡힐 수 있어 시작 시각을 앞으로 당긴다
const MATCH_END_MARGIN_MS = 60 * 1000;

const TABLE = 'godo_review_imported';

// 서버리스 인스턴스마다 풀을 하나만 맺고 재사용한다. 요청마다 연결을 맺고 끊고 DDL을
// 다시 돌리면 요청당 수백 ms씩 낭비돼 대량 이관이 그만큼 느려진다 (cafe24-review b75caf8).
let shared: postgres.Sql | null = null;
let schemaReady = false;
let schemaPromise: Promise<unknown> | null = null;
const CLAIMS = 'godomall_review_write_attempt';

function db(): postgres.Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!shared) shared = postgres(url, { max: 1, idle_timeout: 20, max_lifetime: 1800, connect_timeout: 5, connection: { statement_timeout: 5000 } });
  return shared;
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const sql = db();
  if (!sql) return null;
  try {
    if (!schemaReady) {
      schemaPromise ??= sql.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtext(${TABLE}))`;
        await sql`
          create table if not exists ${sql(TABLE)} (
            import_key text primary key,
            mall_no bigint not null,
            article_sno bigint,
            goods_no bigint not null,
            writer text not null,
            score int not null,
            content text not null,
            image_url text,
            created_date text,
            dedup_hash text,
            photo_dropped boolean not null default false,
            imported_at timestamptz not null default now()
          )`;
        // 기존 배포 표에 해시·사진누락 컬럼을 안전하게 얹는다. 구형 행은 dedup_hash가 NULL이라
        // 부분 인덱스에서 제외돼 과거 기록과 부딪히지 않는다.
        await sql`alter table ${sql(TABLE)} add column if not exists dedup_hash text`;
        // 사진이 빠진 채 등록된 글 표시 — 저장 공간 복구 후 대상만 골라 삭제·재이관하기 위함이다.
        await sql`alter table ${sql(TABLE)} add column if not exists photo_dropped boolean not null default false`;
        // 재전송 필터(splitByExisting)는 확인(article_sno) 여부와 무관하게 해시를 본다 —
        // 미확인 행까지 봐야 재전송 차단 여부를 판단하기 때문. 초기 배포에서 만든 부분 인덱스
        // (article_sno 조건 포함)는 이 쿼리를 못 타므로 조건이 넓은 인덱스로 교체한다.
        const hashIdx = await sql<{ ok: number }[]>`
          select 1 as ok from pg_class where relname = 'godo_review_imported_hash_idx'`;
        if (!hashIdx.length) {
          await sql`drop index if exists godo_review_imported_mall_hash_idx`;
          await sql`create index godo_review_imported_hash_idx
            on ${sql(TABLE)} (mall_no, goods_no, dedup_hash)
            where dedup_hash is not null`;
        }
        await sql`create table if not exists ${sql(CLAIMS)} (
          shop_id text not null, dedup_hash text not null, attempted_at timestamptz not null default now(),
          primary key (shop_id, dedup_hash))`;
        await sql`alter table ${sql(TABLE)} add column if not exists write_confirmed boolean not null default false`;
      });
      try { await schemaPromise; schemaReady = true; }
      catch (error) { schemaPromise = null; throw error; }
    }
    return await fn(sql);
  } catch (e) {
    // 연결 계열 오류일 때만 풀을 버려 다음 호출이 새로 맺게 한다. 순수 SQL 오류까지
    // 버리면 다음 호출마다 연결·DDL을 다시 하게 된다. 스키마는 DB에 있으니 한 번
    // 확인됐으면 풀이 바뀌어도 다시 확인할 필요가 없다.
    const msg = ((e as Error).message ?? '').toLowerCase();
    if (shared === sql && /connect|socket|etimedout|econn|terminat|closed|reset|timeout/.test(msg)) {
      shared = null;
    }
    throw e;
  }
}

export async function recordImports(mallNo: number, rows: NewImport[]): Promise<void> {
  if (!rows.length) return;
  {
    // 한 줄이라도 undefined/NaN이 있으면 postgres가 통째로 거부한다(UNDEFINED_VALUE).
    // 값은 전부 안전한 원시형으로 다듬고, 상품번호가 이상한 줄은 버린다.
    const safe = rows
      .map(
        (r) =>
          [
            randomUUID(),
            String(mallNo),
            Number(r.goods_no),
            String(r.writer ?? '익명').slice(0, 200),
            Math.min(5, Math.max(1, Math.round(Number(r.score) || 5))),
            String(r.content ?? '').slice(0, 10000),
            r.images?.[0] == null ? null : String(r.images[0]).slice(0, 2000),
            r.created_date == null ? null : String(r.created_date).slice(0, 40),
            r.dedup_hash == null ? null : String(r.dedup_hash).slice(0, 64),
            // Pass real booleans: postgres serializes strings such as "true" as false.
            r.photo_dropped === true,
            true,
          ] as [string, string, number, string, number, string, string | null, string | null, string | null, boolean, boolean],
      )
      .filter((r) => Number.isFinite(r[2]) && r[2] > 0);
    if (safe.length !== rows.length) throw new Error('Invalid ledger row');
    const saved = await withDb(async (sql) => {
      // ⚠️ postgres 3.4.9의 sql(객체배열, ...컬럼) 헬퍼는 값이 전부 정의돼 있어도
      // UNDEFINED_VALUE를 뱉는다(2026-09 실측·로컬 재현). 배열-of-배열로 직접 넣는다.
      await sql`
        insert into ${sql(TABLE)} (import_key, mall_no, goods_no, writer, score, content, image_url, created_date, dedup_hash, photo_dropped, write_confirmed)
        values ${sql(safe as unknown as readonly (string | number)[][])}
        on conflict (import_key) do nothing`;
      return true;
    });
    if (!saved) throw new Error('Review storage is unavailable');
  }
}

/** Occurrence-aware legacy matching; unresolved old imports remain blocked. */
export async function splitByExisting(
  shopId: number, productId: number, hashes: string[],
  identities: ReviewIdentity[] = hashes.map(legacyHash => ({ legacyHash, occurrence: 0 })),
): Promise<{ pendingIndices: number[]; already: number; blocked: number }> {
  const currentAliases = hashes.map((hash, index) => [...new Set([hash, ...(identities[index]?.aliases ?? [])])]);
  const legacyAliases = identities.map((identity) => [...new Set([identity.legacyHash, ...(identity.legacyAliases ?? [])])]);
  const keys = [...new Set([...currentAliases.flat(), ...legacyAliases.flat()])];
  if (!keys.length) return { pendingIndices: [], already: 0, blocked: 0 };
  const result = await withDb(async (sql) => {
    const rows = await sql<{ dedup_hash: string; confirmed: boolean }[]>`
      select dedup_hash, (article_sno is not null or write_confirmed) as confirmed from ${sql(TABLE)}
      where mall_no = ${shopId} and goods_no = ${productId} and dedup_hash in ${sql(keys)}`;
    const recordedHashes = new Set(rows.map((row) => row.dedup_hash));
    const claims = await sql<{ dedup_hash: string }[]>`
      select dedup_hash from ${sql(CLAIMS)} where shop_id = ${String(shopId)} and dedup_hash in ${sql(keys)}`;
    const blockedHashes = new Set(claims.map(r => r.dedup_hash).filter((hash) => !recordedHashes.has(hash)));
    const counts = new Map<string, number>();
    const unresolved = new Set<string>();
    for (const row of rows) {
      if (row.confirmed) counts.set(row.dedup_hash, (counts.get(row.dedup_hash) ?? 0) + 1);
      else unresolved.add(row.dedup_hash);
    }
    const countAliases = (aliases: string[]) => [...new Set(aliases)].reduce((total, alias) => total + (counts.get(alias) ?? 0), 0);
    let already = 0; let blocked = 0; const pendingIndices: number[] = [];
    hashes.forEach((hash, index) => {
      const identity = identities[index] ?? { legacyHash: hash, occurrence: 0 };
      const exact = countAliases(currentAliases[index]);
      const legacy = countAliases(legacyAliases[index]);
      const currentBlocked = currentAliases[index].some((alias) => blockedHashes.has(alias) || unresolved.has(alias));
      const legacyBlocked = legacyAliases[index].some((alias) => blockedHashes.has(alias) || unresolved.has(alias));
      if ((hash !== identity.legacyHash && exact > 0) || legacy > identity.occurrence) already++;
      else if (currentBlocked || legacyBlocked) blocked++;
      else pendingIndices.push(index);
    });
    return { pendingIndices, already, blocked };
  });
  if (!result) throw new Error('Review storage is unavailable');
  return result;
}

/** Claim before POST; claims survive crashes and never expire automatically. */
export async function claimImports(shopId: number, hashes: string[]): Promise<boolean> {
  if (!hashes.length) return true;
  const collision = new Error('write already claimed');
  try {
    const result = await withDb(sql => sql.begin(async tx => {
      const values = hashes.map(hash => [String(shopId), hash]);
      const claimed = await tx`insert into ${tx(CLAIMS)} (shop_id, dedup_hash)
        values ${tx(values)} on conflict do nothing returning dedup_hash`;
      if (claimed.length !== hashes.length) throw collision;
      return true;
    }));
    if (!result) throw new Error('Review storage is unavailable');
    return true;
  } catch (error) {
    if (error === collision) return false;
    throw error;
  }
}

/** Only a definite non-creation or verified deletion may release a claim. */
export async function releaseClaims(shopId: number, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  const result = await withDb(async sql => {
    await sql`delete from ${sql(CLAIMS)} where shop_id = ${String(shopId)} and dedup_hash in ${sql(hashes)}`;
    return true;
  });
  if (!result) throw new Error('Review storage is unavailable');
}

/** 목록·삭제 공통 WHERE — 상품 필터와 사진 누락(photo_dropped) 필터를 함께 조립한다. */
function importsWhere(
  sql: postgres.Sql,
  mallNo: number,
  opts: { productNo?: number; photoDroppedOnly?: boolean },
) {
  return sql`where mall_no = ${mallNo}
    ${opts.productNo ? sql`and goods_no = ${opts.productNo}` : sql``}
    ${opts.photoDroppedOnly ? sql`and photo_dropped = true` : sql``}`;
}

/** 이 몰이 옮긴 리뷰 목록. 상품·사진누락 필터, 최신순, 페이지네이션. */
export async function listImports(
  mallNo: number,
  opts: { productNo?: number; photoDroppedOnly?: boolean; page?: number; pageSize?: number } = {},
): Promise<{ rows: ImportedReviewRow[]; total: number } | null> {
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const offset = Math.max(0, (opts.page ?? 1) - 1) * pageSize;
  return withDb(async (sql) => {
    const where = importsWhere(sql, mallNo, opts);
    const [rows, total] = await Promise.all([
      sql<ImportedReviewRow[]>`
        select import_key, article_sno, goods_no, writer, score, content, image_url, created_date, imported_at, photo_dropped
        from ${sql(TABLE)} ${where}
        order by imported_at desc, import_key desc
        limit ${pageSize} offset ${offset}`,
      sql<{ n: string }[]>`select count(*) as n from ${sql(TABLE)} ${where}`,
    ]);
    return { rows: rows.map(row => ({ ...row, goods_no: Number(row.goods_no), article_sno: row.article_sno == null ? null : Number(row.article_sno) })), total: Number(total[0]?.n ?? 0) };
  });
}

/** 고도몰에서 실제 삭제에 성공한 글 번호만 원장에서 지운다. */
export async function removeImports(mallNo: number, articleSnos: number[]): Promise<void> {
  if (!articleSnos.length) return;
  const removed = await withDb(sql => sql.begin(async tx => {
    const rows = await tx<{ dedup_hash: string | null }[]>`delete from ${tx(TABLE)} where mall_no = ${mallNo} and article_sno in ${tx(articleSnos)} returning dedup_hash`;
    const hashes = rows.flatMap(row => row.dedup_hash ? [row.dedup_hash] : []);
    if (hashes.length) await tx`delete from ${tx(CLAIMS)} where shop_id = ${String(mallNo)} and dedup_hash in ${tx(hashes)}
      and not exists (select 1 from ${tx(TABLE)} where mall_no = ${mallNo} and dedup_hash = ${tx(CLAIMS)}.dedup_hash)`;
    return true;
  }));
  if (!removed) throw new Error('Review storage is unavailable');
}

/** 필터에 해당하는 확인된 글 번호를 최대 limit개 꺼낸다. 전체 삭제 진행용(서버 순회). */
export async function listArticleNos(
  mallNo: number,
  opts: { productNo?: number; photoDroppedOnly?: boolean } = {},
  limit = 50,
): Promise<number[] | null> {
  return withDb(async (sql) => {
    const where = sql`${importsWhere(sql, mallNo, opts)} and article_sno is not null`;
    const rows = await sql<{ article_sno: number }[]>`
      select article_sno from ${sql(TABLE)} ${where} order by article_sno limit ${limit}`;
    return rows.map((r) => Number(r.article_sno)).filter(Number.isSafeInteger);
  });
}

/** 글 번호가 아직 없는 원장 행을 고도몰 상품 후기 게시판과 대조해 article_sno를 채운다. */
export async function reconcileImports(token: string, mallNo: number): Promise<void> {
  await withDb(async (sql) => {
    type Pending = { import_key: string; goods_no: number; writer: string; score: number; content: string; image_url: string | null; imported_at: Date; match_count: number };
    const pending = await sql<Pending[]>`
      select import_key, goods_no, writer, score, content, image_url, imported_at,
        count(*) over (partition by goods_no, writer, content, score) as match_count
      from ${sql(TABLE)}
      where mall_no = ${mallNo} and article_sno is null
      order by imported_at asc, import_key asc limit 1000`;
    if (!pending.length) return;

    // 가장 오래된 미대조 행의 등록 시각부터 지금까지를 시간 창으로 잡는다 (등록일 필터만 지원되는 API라서).
    const start = new Date(pending[0].imported_at.getTime() - MATCH_START_MARGIN_MS);
    const end = new Date(Date.now() + MATCH_END_MARGIN_MS);
    const articles: GoodsReviewArticle[] = [];
    const deadline = Date.now() + 20000;
    for (let page = 1; page <= MATCH_PAGES_MAX && Date.now() < deadline; page++) {
      const res = await listGoodsReviewArticles(token, {
        registerStartDate: fmtKst(start),
        registerEndDate: fmtKst(end),
        page,
        pageSize: MATCH_PAGE_SIZE,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      articles.push(...(res.contents ?? []));
      if (articles.length >= (res.totalCount ?? 0)) break;
      if ((res.contents ?? []).length === 0) break;
    }
    if (!articles.length) return;

    const assigned = await sql<{ article_sno: string }[]>`
      select article_sno from ${sql(TABLE)} where mall_no = ${mallNo} and article_sno is not null`;
    const used = new Set(assigned.map(row => Number(row.article_sno)));
    const key = (goods: number, writer: string, content: string, score: number | null) => JSON.stringify([Number(goods), writer, content, score]);
    const candidates = new Map<string, GoodsReviewArticle[]>();
    for (const article of articles) {
      if (!Number.isSafeInteger(article.sno) || used.has(article.sno)) continue;
      const k = key(article.goodsSno, article.writerName, article.content, article.rating);
      const bucket = candidates.get(k) ?? [];
      if (!bucket.some(item => item.sno === article.sno)) bucket.push(article);
      candidates.set(k, bucket);
    }
    const counts = new Map<string, number>();
    for (const row of pending) {
      const k = key(row.goods_no, row.writer, row.content, row.score);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // Only unique exact matches are assigned. Identical or transformed-photo candidates
    // need manual verification; they must not become automatic deletion targets.
    for (const row of pending) {
      const k = key(row.goods_no, row.writer, row.content, row.score);
      const bucket = candidates.get(k) ?? [];
      if (Number(row.match_count) !== 1 || counts.get(k) !== 1 || bucket.length !== 1) continue;
      const article = bucket[0];
      const attachments = article.attachments ?? [];
      if (row.image_url ? !attachments.some(image => image.url === row.image_url) : attachments.length > 0) continue;
      const date = article.registerDateTime;
      const registered = date ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(date) ? date : date.replace(' ', 'T') + '+09:00') : NaN;
      if (!Number.isFinite(registered) || Math.abs(registered - row.imported_at.getTime()) > MATCH_START_MARGIN_MS) continue;
      await sql`update ${sql(TABLE)} set article_sno = ${article.sno} where import_key = ${row.import_key} and article_sno is null`;
    }
  });
}

/** 고도몰 서버 API의 일시 필터 형식(yyyy-MM-dd HH:mm:ss, KST)으로 만든다. */
function fmtKst(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export async function ownedArticleNos(mallNo: number, articleSnos: number[]): Promise<number[]> {
  if (!articleSnos.length) return [];
  const result = await withDb(async sql => {
    const rows = await sql<{ article_sno: string }[]>`select article_sno from ${sql(TABLE)} where mall_no = ${mallNo} and article_sno in ${sql(articleSnos)}`;
    return rows.map(row => Number(row.article_sno));
  });
  if (!result) throw new Error('Review storage is unavailable');
  return result;
}
