import postgres from 'postgres';

// 무료 20건(쇼핑몰당 평생 한도) — 소진 후 402(유료 미가입 시). paid면 무제한(사용량 집계 생략).
// 웹훅 DELETED 시 리셋하지 않는다 — 삭제→재설치로 한도가 되살아나는 것을 막는다.
export const FREE_LIMIT = 20;

export async function checkQuota(mallNo: number, want: number, paid = false) {
  const url = process.env.DATABASE_URL;
  if (paid) return { allowed: want, paid: true, used: 0, configured: true };
  // 사용량을 저장할 수 없으면 무료 한도를 우회시키지 않고 호출자가 중단하게 한다.
  if (!url) return { allowed: 0, paid: false, used: 0, configured: false };

  const sql = postgres(url, { max: 1 });
  await sql`create table if not exists usage_counter (
    mall_id text primary key, written int not null default 0, updated_at timestamptz not null default now())`;
  const [row] = await sql<{ written: number }[]>`select written from usage_counter where mall_id = ${String(mallNo)}`;
  const used = row?.written ?? 0;
  await sql.end();
  return { allowed: Math.max(0, FREE_LIMIT - used), paid: false, used, configured: true };
}

export async function addUsage(mallNo: number, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  await sql`insert into usage_counter (mall_id, written) values (${String(mallNo)}, ${n})
            on conflict (mall_id) do update set written = usage_counter.written + ${n}, updated_at = now()`;
  await sql.end();
}

/**
 * 무료 한도를 원자적으로 예약한다. checkQuota(읽기) → addUsage(쓰기) 사이에 다른 요청이
 * 끼면 동시 요청이 한도를 같이 넘을 수 있다. 예약을 하나의 UPDATE로 만들어 초과만 거부한다.
 * 예약 후 실제로 못 쓴 분량은 releaseQuota로 돌려준다. (cafe24-review 이식)
 * 반환 ok=false면 한도 초과(used는 현재 사용량).
 */
export async function reserveQuota(
  mallNo: number,
  n: number,
): Promise<{ ok: boolean; used: number }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: true, used: 0 };
  const sql = postgres(url, { max: 1 });
  try {
    await sql`create table if not exists usage_counter (
      mall_id text primary key, written int not null default 0, updated_at timestamptz not null default now())`;
    if (n <= 0) {
      const [row] = await sql<{ written: number }[]>`select written from usage_counter where mall_id = ${String(mallNo)}`;
      return { ok: true, used: row?.written ?? 0 };
    }
    const [row] = await sql<{ written: number }[]>`
      update usage_counter set written = written + ${n}, updated_at = now()
      where mall_id = ${String(mallNo)} and written + ${n} <= ${FREE_LIMIT}
      returning written`;
    if (row) return { ok: true, used: row.written };
    // where 조건을 못 맞춘 경우(행이 없거나 한도 초과) — 행이 없으면 0건이라 실패로 본다.
    const [cur] = await sql<{ written: number }[]>`select written from usage_counter where mall_id = ${String(mallNo)}`;
    return { ok: false, used: cur?.written ?? FREE_LIMIT };
  } finally {
    await sql.end();
  }
}

/** 예약만 하고 실제로 쓰지 못한 분량을 돌려준다. */
export async function releaseQuota(mallNo: number, n: number) {
  const url = process.env.DATABASE_URL;
  if (!url || n <= 0) return;
  const sql = postgres(url, { max: 1 });
  await sql`update usage_counter set written = greatest(0, written - ${n}), updated_at = now()
            where mall_id = ${String(mallNo)}`;
  await sql.end();
}
