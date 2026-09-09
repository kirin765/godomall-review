import { createHash, randomUUID } from 'crypto';
import postgres from 'postgres';
import { listGoodsReviewArticles, type GoodsReviewArticle } from '@/lib/godomall';

/**
 * 리뷰이사가 옮긴 리뷰 원장. 옮기기 성공 시 기록해 두고 관리 화면에서 걸러 보고,
 * 골라서 고도몰 상품 후기 게시판에서 실제 삭제할 수 있게 한다.
 *
 * 카페24판과 달리 고도몰 bulk 등록 응답({success, fail, failMessage})에는 글 번호가 없다.
 * 그래서 등록 직후 (·관리 화면 목록을 열 때) 상품 후기 게시판(goodsreview) 목록과
 * (상품·작성자·본문·평점)을 대조해 article_sno를 채운다(reconcileImports).
 * 그 sno가 있어야만 DELETE /boards/goodsreview/articles/{sno}로 지울 수 있다.
 * (과거 옮긴 글은 기록이 없어 자동 식별 불가 — 기능은 이 배포 이후 옮긴 글부터 적용된다.)
 *
 * dedup_hash: 같은 리뷰를 다시 보냈을 때(브라우저 재시작·요청 중단 후 재시도 등) 중복
 * 등록을 막기 위한 내용 해시. 고도몰 bulk API는 "어느 행이 성공"인지를 주지 않으므로
 * **게시판과 대조돼 article_sno까지 확인된 행만** 재전송에서 건너뛴다(splitByExisting).
 * 아직 확인 안 된 행(article_sno NULL)은 다시 보내 안전하게 만든다 — "부분 멱등".
 *
 * ⚠️ 테이블 명을 고유하게(`godo_review_imported`) 쓴다. 이 DATABASE_URL은 다른 프로젝트와
 *    공유되는 DB라, 제네릭한 `imported_review`라는 이름이 다른 앱의 테이블과 충돌해
 *    `column "import_key" does not exist` 같은 스키마가 어긋나는 문제가 실제로 발생했다
 *    (운영 로그 실측, 2026-09-01).
 */

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
};

export type NewImport = {
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
  dedup_hash?: string | null;
};

/**
 * 리뷰 내용으로 중복 판정용 해시를 만든다. 같은 상품·작성자·평점·본문(옵션 포함)·이미지·
 * 작성일이면 같은 해시 → 재전송 시 게시판에 확인된 것으로 보고 건너뛴다.
 * 주의: 원장/요청 어디서든 같은 결과가 나오려면, 해시는 **보내는 값과 똑같이 정제된** 값으로
 * 만들어야 한다(writeReviews.toNewImport가 만든 값 그대로). 정제 전 원본으로 만들면
 * 재전송 간 값이 어긋나 멱등이 깨진다(cafe24-review 2464d56 교훈).
 */
export function reviewHash(
  goodsNo: number,
  r: {
    writer: string;
    score: number;
    content: string;
    image_url?: string | null;
    created_date?: string | null;
  },
): string {
  const parts = [
    String(goodsNo),
    String(r.writer ?? ''),
    String(r.score ?? ''),
    String(r.content ?? ''),
    String(r.image_url ?? ''),
    String(r.created_date ?? ''),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

// 고도몰 server API 스펙(server-docs.godomall.com/spec/server-api.yml) 기준:
// GET /boards/goodsreview/articles 는 pageSize 기본 100, 최대 10000. 상품 후기 게시판은
// 하루에 리뷰가 수백 건이어도 대량 이관 직후엔 시간 창 안에 수천~만 건이 몰릴 수 있어
// 최대값(10000)으로 페이지를 줄여 조회 왕복을 최소화한다.
const MATCH_PAGES_MAX = 10; // 안전망: 시간 창 안 게시글이 아무리 많아도 10만 건까지만 대조한다
const MATCH_PAGE_SIZE = 10000;
const MATCH_START_MARGIN_MS = 2 * 60 * 1000; // 등록 직후 목록에 안 잡힐 수 있어 시작 시각을 앞으로 당긴다
const MATCH_END_MARGIN_MS = 60 * 1000;

const TABLE = 'godo_review_imported';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
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
        imported_at timestamptz not null default now()
      )`;
    // 기존 배포 표에 해시 컬럼을 안전하게 얹는다. 구형 행은 dedup_hash가 NULL이라
    // 부분 인덱스에서 제외돼 과거 기록과 부딪히지 않는다.
    await sql`alter table ${sql(TABLE)} add column if not exists dedup_hash text`;
    // 재전송 필터(splitByExisting)는 확인(article_sno) 여부와 무관하게 해시를 본다 —
    // 미확인 행까지 봐야 needsReconcile 판단이 되기 때문. 초기 배포에서 만든 부분 인덱스
    // (article_sno 조건 포함)는 이 쿼리를 못 타므로 조건이 넓은 인덱스로 교체한다.
    const hashIdx = await sql<{ ok: number }[]>`
      select 1 as ok from pg_class where relname = 'godo_review_imported_hash_idx'`;
    if (!hashIdx.length) {
      await sql`drop index if exists godo_review_imported_mall_hash_idx`;
      await sql`create index godo_review_imported_hash_idx
        on ${sql(TABLE)} (mall_no, goods_no, dedup_hash)
        where dedup_hash is not null`;
    }
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** 옮기기 성공으로 집계된 리뷰를 원장에 남긴다. 글 번호는 뒤늦게 대조해서 채운다. 실패해도 조용히 넘어간다. */
export async function recordImports(mallNo: number, rows: NewImport[]): Promise<void> {
  if (!rows.length) return;
  try {
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
            r.image_url == null ? null : String(r.image_url).slice(0, 2000),
            r.created_date == null ? null : String(r.created_date).slice(0, 40),
            r.dedup_hash == null ? null : String(r.dedup_hash).slice(0, 64),
          ] as [string, string, number, string, number, string, string | null, string | null, string | null],
      )
      .filter((r) => Number.isFinite(r[2]) && r[2] > 0);
    if (!safe.length) return;
    await withDb(async (sql) => {
      // ⚠️ postgres 3.4.9의 sql(객체배열, ...컬럼) 헬퍼는 값이 전부 정의돼 있어도
      // UNDEFINED_VALUE를 뱉는다(2026-09 실측·로컬 재현). 배열-of-배열로 직접 넣는다.
      await sql`
        insert into ${sql(TABLE)} (import_key, mall_no, goods_no, writer, score, content, image_url, created_date, dedup_hash)
        values ${sql(safe as unknown as readonly (string | number)[][])}
        on conflict (import_key) do nothing`;
    });
  } catch (e) {
    console.error('[imports] record failed', (e as Error).message);
  }
}

/**
 * 이미 게시판에 확인된 리뷰(내용 해시 + article_sno 확정)를 가려낸다.
 * 반환:
 *  - confirmedHashes: 재전송해도 중복일 해시 (이미 게시판에 글이 있는 것으로 확인됨)
 *  - needsReconcile: 같은 해시가 아직 article_sno 미확정으로 남아 있는지. true면 호출자는
 *    대조(reconcileImports)를 먼저 돌려 이 중 실제로 올라간 글을 확정시킨 뒤 다시 판정해야 한다.
 *    (요청이 죽은 뒤 재시도했을 때 "올라갔는데 응답을 못 받은" 배치가 여기 걸린다.)
 * DB가 없으면 null → 호출자는 중복 제거 없이 그대로 진행한다.
 */
export async function splitByExisting(
  mallNo: number,
  goodsNo: number,
  hashes: string[],
): Promise<{ confirmedHashes: Set<string>; needsReconcile: boolean } | null> {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return { confirmedHashes: new Set(), needsReconcile: false };
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return withDb(async (sql) => {
    const rows = await sql<{ dedup_hash: string; article_sno: number | null }[]>`
      select dedup_hash, article_sno from ${sql(TABLE)}
      where mall_no = ${mallNo} and goods_no = ${goodsNo}
        and dedup_hash in ${sql(unique)} and dedup_hash is not null`;
    const confirmedHashes = new Set<string>();
    let needsReconcile = false;
    for (const r of rows) {
      if (r.article_sno != null) confirmedHashes.add(r.dedup_hash);
      else needsReconcile = true;
    }
    return { confirmedHashes, needsReconcile };
  });
}

/** 이 몰이 옮긴 리뷰 목록. 상품 필터가 있으면 그 상품만. 최신순, 페이지네이션. */
export async function listImports(
  mallNo: number,
  opts: { productNo?: number; page?: number; pageSize?: number } = {},
): Promise<{ rows: ImportedReviewRow[]; total: number } | null> {
  const productNo = opts.productNo;
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const offset = Math.max(0, (opts.page ?? 1) - 1) * pageSize;
  return withDb(async (sql) => {
    const where = productNo
      ? sql`where mall_no = ${mallNo} and goods_no = ${productNo}`
      : sql`where mall_no = ${mallNo}`;
    const [rows, total] = await Promise.all([
      sql<ImportedReviewRow[]>`
        select import_key, article_sno, goods_no, writer, score, content, image_url, created_date, imported_at
        from ${sql(TABLE)} ${where}
        order by imported_at desc
        limit ${pageSize} offset ${offset}`,
      sql<{ n: string }[]>`select count(*) as n from ${sql(TABLE)} ${where}`,
    ]);
    return { rows, total: Number(total[0]?.n ?? 0) };
  });
}

/** 고도몰에서 실제 삭제에 성공한 글 번호만 원장에서 지운다. */
export async function removeImports(mallNo: number, articleSnos: number[]): Promise<void> {
  if (!articleSnos.length) return;
  await withDb(async (sql) => {
    await sql`delete from ${sql(TABLE)} where mall_no = ${mallNo} and article_sno in ${sql(articleSnos)}`;
  });
}

/** 필터에 해당하는 확인된 글 번호를 최대 limit개 꺼낸다. 전체 삭제 진행용(서버 순회). */
export async function listArticleNos(mallNo: number, productNo?: number, limit = 50): Promise<number[] | null> {
  return withDb(async (sql) => {
    const where = productNo
      ? sql`where mall_no = ${mallNo} and goods_no = ${productNo} and article_sno is not null`
      : sql`where mall_no = ${mallNo} and article_sno is not null`;
    const rows = await sql<{ article_sno: number }[]>`
      select article_sno from ${sql(TABLE)} ${where} order by article_sno limit ${limit}`;
    return rows.map((r) => r.article_sno).filter((n) => n != null);
  });
}

/** 글 번호가 아직 없는 원장 행을 고도몰 상품 후기 게시판과 대조해 article_sno를 채운다. */
export async function reconcileImports(token: string, mallNo: number): Promise<void> {
  await withDb(async (sql) => {
    type Pending = { import_key: string; goods_no: number; writer: string; score: number; content: string; imported_at: Date };
    const pending = await sql<Pending[]>`
      select import_key, goods_no, writer, score, content, imported_at
      from ${sql(TABLE)}
      where mall_no = ${mallNo} and article_sno is null
      order by imported_at asc`;
    if (!pending.length) return;

    // 가장 오래된 미대조 행의 등록 시각부터 지금까지를 시간 창으로 잡는다 (등록일 필터만 지원되는 API라서).
    const start = new Date(pending[0].imported_at.getTime() - MATCH_START_MARGIN_MS);
    const end = new Date(Date.now() + MATCH_END_MARGIN_MS);
    const articles: GoodsReviewArticle[] = [];
    for (let page = 1; page <= MATCH_PAGES_MAX; page++) {
      const res = await listGoodsReviewArticles(token, {
        registerStartDate: fmtKst(start),
        registerEndDate: fmtKst(end),
        page,
        pageSize: MATCH_PAGE_SIZE,
      });
      articles.push(...(res.contents ?? []));
      if (articles.length >= (res.totalCount ?? 0)) break;
      if ((res.contents ?? []).length === 0) break;
    }
    if (!articles.length) return;

    // 같은 값으로 여러 건 옮겼을 때 한 글에 여러 원장이 붙지 않게, 대조된 글은 후보 풀에서 뺀다.
    const pool = [...articles];
    for (const p of pending) {
      const ai = pool.findIndex(
        (a) =>
          a.sno != null &&
          a.goodsSno === p.goods_no &&
          (a.writerName ?? '') === p.writer &&
          (a.content ?? '') === p.content &&
          (a.rating ?? null) === p.score,
      );
      if (ai < 0) continue;
      await sql`update ${sql(TABLE)} set article_sno = ${pool[ai].sno} where import_key = ${p.import_key}`;
      pool.splice(ai, 1);
    }
  });
}

/** 고도몰 서버 API의 일시 필터 형식(yyyy-MM-dd HH:mm:ss, KST)으로 만든다. */
function fmtKst(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
}
