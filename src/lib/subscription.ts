import postgres from 'postgres';

/**
 * godomall 버전의 라이선스 원장 (Paddle 결제 연동).
 *
 * Paddle이 월 9,900원 구독을 징수한다. 웹훅(subscription.activated 등)이 이 원장을
 * 갱신해 "이 몰이 유료인가"를 판정하고, godomall /app-installed/extend로 만료일을
 * 함께 연장한다. paid_until은 Paddle 구독의 current_billing_period.ends_at을 따른다.
 *
 * godomall 토큰은 DB(godo_install)에 있어 서버 웹훅이 extend를 호출할 수 있다.
 */
export type Subscription = {
  mall_no: string;
  status: 'active' | 'canceled';
  paid_until: Date;
  paddle_sub_id: string | null;
  paddle_status: string | null;
  updated_at: Date;
};

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`create table if not exists godo_subscription (
      mall_no text primary key,
      status text not null default 'active',
      paid_until timestamptz not null,
      paddle_sub_id text,
      paddle_status text,
      updated_at timestamptz not null default now())`;
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export const getSubscription = (mallNo: string | number) =>
  withDb(async (sql) => {
    const [row] = await sql<Subscription[]>`select * from godo_subscription where mall_no = ${String(mallNo)}`;
    return row ?? null;
  });

export const isActive = (s: Subscription | null | undefined) =>
  !!s && s.status === 'active' && new Date(s.paid_until) > new Date();

/**
 * Paddle 구독 활성(결제 확인) 시 원장 갱신. paid_until은 Paddle billing period 종료일.
 * 이미 더 뒤에 만료되는 기존 구독이면 유지(연장하지 않음).
 */
export const upsertFromPaddle = (
  mallNo: string | number,
  paidUntil: Date,
  paddleSubId: string,
  paddleStatus: string,
) =>
  withDb(async (sql) => {
    await sql`insert into godo_subscription (mall_no, status, paid_until, paddle_sub_id, paddle_status)
      values (${String(mallNo)}, 'active', ${paidUntil}, ${paddleSubId}, ${paddleStatus})
      on conflict (mall_no) do update set
        status = 'active',
        paid_until = greatest(godo_subscription.paid_until, ${paidUntil}),
        paddle_sub_id = ${paddleSubId},
        paddle_status = ${paddleStatus},
        updated_at = now()`;
  });

/** Paddle 구독 해지/만료 시 로컬 판정을 비활성화한다. godomall 연장은 스스로 만료되도록 둔다. */
export const cancelFromPaddle = (mallNo: string | number) =>
  withDb(async (sql) => {
    await sql`update godo_subscription set status = 'canceled', updated_at = now() where mall_no = ${String(mallNo)}`;
  });

/** 앱 삭제·만료 시 원장 폐기. 재설치하면 새 라이선스. */
export const cancel = (mallNo: string | number) =>
  withDb(async (sql) => {
    await sql`delete from godo_subscription where mall_no = ${String(mallNo)}`;
  });
