import postgres from 'postgres';

// 무료 플랜: 체험 14일 동안 **하루 20건**(한국시간 자정에 리셋). paid면 무제한(사용량 집계 생략).
//  - 리셋 기준은 KST 자정이다 — 서버가 UTC로 돌아도 셀러가 기대하는 "오늘"과 어긋나지 않게 한다.
//  - 사용량은 몰 ID + 날짜로 남기므로 삭제·재설치해도 그날 한도가 되살아나지 않는다(웹훅 DELETED가
//    이 표를 지우지 않는다). 14일 체험 시작 시각은 godo_trial(godo_trial.ts)에 따로 남긴다.
export const FREE_LIMIT = 20;
export const FREE_TRIAL_DAYS = 14;

/** 이 앱 전용 테이블명 — 공유 DATABASE_URL이라 제네릭한 이름은 다른 앱과 충돌한다(2026-09-01 실측). */
const TABLE = 'godo_daily_usage';

/** KST 기준 오늘 날짜(YYYY-MM-DD). en-CA 로케일이 ISO 형태를 준다. */
export function kstDay(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

async function ensureTable(sql: postgres.Sql) {
  await sql`create table if not exists ${sql(TABLE)} (
    mall_id text not null,
    day date not null,
    written int not null default 0,
    updated_at timestamptz not null default now(),
    primary key (mall_id, day))`;
}

export async function checkQuota(mallNo: number, want: number, paid = false) {
  const url = process.env.DATABASE_URL;
  if (paid) return { allowed: want, paid: true, used: 0, configured: true, day: kstDay() };
  // 사용량을 저장할 수 없으면 무료 한도를 우회시키지 않고 호출자가 중단하게 한다.
  if (!url) return { allowed: 0, paid: false, used: 0, configured: false, day: kstDay() };

  const sql = postgres(url, { max: 1 });
  try {
    await ensureTable(sql);
    const day = kstDay();
    const [row] = await sql<{ written: number }[]>`
      select written from ${sql(TABLE)} where mall_id = ${String(mallNo)} and day = ${day}`;
    const used = row?.written ?? 0;
    return { allowed: Math.max(0, FREE_LIMIT - used), paid: false, used, configured: true, day };
  } finally {
    await sql.end();
  }
}

/** 오늘 사용량을 올린다(집계 실패는 흐름을 막지 않음). */
export async function addUsage(mallNo: number, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  try {
    await ensureTable(sql);
    const day = kstDay();
    await sql`insert into ${sql(TABLE)} (mall_id, day, written) values (${String(mallNo)}, ${day}, ${n})
              on conflict (mall_id, day) do update set written = ${sql(TABLE)}.written + ${n}, updated_at = now()`;
  } finally {
    await sql.end();
  }
}

/**
 * 오늘 한도를 원자적으로 예약한다. checkQuota(읽기) → addUsage(쓰기) 사이에 다른 요청이
 * 끼면 동시 요청이 한도를 같이 넘을 수 있다. 예약을 하나의 UPDATE로 만들어 초과만 거부한다.
 * 예약 후 실제로 못 쓴 분량은 releaseQuota로 돌려준다. (cafe24-review 이식)
 * 반환 ok=false면 한도 초과(used는 현재 사용량).
 */
export async function reserveQuota(
  mallNo: number,
  n: number,
): Promise<{ ok: boolean; used: number }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, used: 0 };
  const sql = postgres(url, { max: 1 });
  try {
    await ensureTable(sql);
    const day = kstDay();
    // 오늘 행이 없으면 먼저 0으로 만들어 둔다(INSERT 자체는 한도 검사를 못 하므로 UPDATE로만 증가).
    await sql`insert into ${sql(TABLE)} (mall_id, day, written) values (${String(mallNo)}, ${day}, 0)
              on conflict (mall_id, day) do nothing`;
    if (n <= 0) {
      const [row] = await sql<{ written: number }[]>`
        select written from ${sql(TABLE)} where mall_id = ${String(mallNo)} and day = ${day}`;
      return { ok: true, used: row?.written ?? 0 };
    }
    const [row] = await sql<{ written: number }[]>`
      update ${sql(TABLE)} set written = written + ${n}, updated_at = now()
      where mall_id = ${String(mallNo)} and day = ${day} and written + ${n} <= ${FREE_LIMIT}
      returning written`;
    if (row) return { ok: true, used: row.written };
    // where 조건을 못 맞춘 경우(한도 초과) — 현재 사용량을 돌려준다.
    const [cur] = await sql<{ written: number }[]>`
      select written from ${sql(TABLE)} where mall_id = ${String(mallNo)} and day = ${day}`;
    return { ok: false, used: cur?.written ?? FREE_LIMIT };
  } finally {
    await sql.end();
  }
}

/** 예약만 하고 실제로 쓰지 못한 분량을 오늘 사용량에서 돌려준다. */
export async function releaseQuota(mallNo: number, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  try {
    await ensureTable(sql);
    const day = kstDay();
    await sql`update ${sql(TABLE)} set written = greatest(0, written - ${n}), updated_at = now()
              where mall_id = ${String(mallNo)} and day = ${day}`;
  } finally {
    await sql.end();
  }
}
