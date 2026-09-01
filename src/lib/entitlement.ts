/**
 * 유료/무료 자격(entitlement) 저장소.
 *
 * 3개 테이블 (DATABASE_URL 없으면 전부 스킵 → 항상 무료 20건, 기존 동작 유지):
 *  - app_tokens        : mall_id → 몰 장기토큰 (판매사가 결제 웹훅에서 extend 호출할 때 사용)
 *  - app_entitlement   : workspace /app-installed/status 결과 캐시 (5분 TTL)
 *  - app_subscriptions : 인앱결제 기록 (paid 판정의 근거)
 */
import postgres from 'postgres';

const FREE = { paid: false, mode: 'free' as const };
const STATUS_TTL_MS = 5 * 60 * 1000;

type AppStatusKind = 'ACTIVE' | 'EXPIRED' | 'DELETED' | 'UNKNOWN';

export type Entitlement = {
  paid: boolean;
  mode: 'plus' | 'free';
  status: AppStatusKind;
  /** 구독/연장 만료일시(ISO) — plus면 구독 만료, free면 null */
  expireAt: string | null;
  checkedAt: number;
};

function sql(): postgres.Sql<Record<string, unknown>> | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return postgres(url, { max: 1 });
}

async function ensureTables(db: postgres.Sql<Record<string, unknown>>) {
  // ⚠️ postgres.js는 prepared statement로 보내서 ';'로 이어진 다중 문장이 거부된다
  // (cannot insert multiple commands into a prepared statement). 문장마다 나눠 보낸다.
  await db`
    create table if not exists app_tokens (
      mall_id text primary key,
      access_token text not null,
      updated_at timestamptz not null default now())`;
  await db`
    create table if not exists app_entitlement (
      mall_id text primary key,
      app_status text not null default 'UNKNOWN',
      expire_ts timestamptz,
      checked_at timestamptz not null default now())`;
  await db`
    create table if not exists app_subscriptions (
      id serial primary key,
      mall_id text not null,
      order_no text not null default '',
      payment_type text not null,
      price int not null,
      until_ts timestamptz not null,
      created_at timestamptz not null default now())`;
  await db`
    create index if not exists idx_sub_mall on app_subscriptions (mall_id, until_ts)`;
}

/** 세션 발급 시 몰 장기토큰 저장 (유료 전환 후 판매사 측 extend 호출에 필요) */
export async function saveToken(mallNo: number, accessToken: string): Promise<void> {
  const db = sql();
  if (!db) return;
  try {
    await ensureTables(db);
    await db`insert into app_tokens (mall_id, access_token) values (${String(mallNo)}, ${accessToken})
             on conflict (mall_id) do update set access_token = excluded.access_token, updated_at = now()`;
  } catch {
    /* DB 장애는 무료 폴백 경로라 침묵 */
  } finally {
    await db.end();
  }
}

export async function getToken(mallNo: number): Promise<string | null> {
  const db = sql();
  if (!db) return null;
  try {
    const rows = await db<{ access_token: string }[]>`select access_token from app_tokens where mall_id = ${String(mallNo)}`;
    return rows[0]?.access_token ?? null;
  } catch {
    return null;
  } finally {
    await db.end();
  }
}

/** 앱 삭제(웹훅 DELETED) 시 오래된 몰 토큰 제거 */
export async function deleteToken(mallNo: number): Promise<void> {
  const db = sql();
  if (!db) return;
  try {
    await ensureTables(db);
    await db`delete from app_tokens where mall_id = ${String(mallNo)}`;
  } catch {
    /* noop */
  } finally {
    await db.end();
  }
}

/** 인앱결제(또는 체험) 기록 — paid 판정 근거. paymentType은 workspace 스펙(TRIAL/CHARGE) 기준. */
export async function recordSubscription(opts: {
  mallNo: number;
  orderNo?: string;
  paymentType: 'TRIAL' | 'CHARGE';
  price: number;
  untilTs: Date;
}): Promise<boolean> {
  const db = sql();
  if (!db) return false;
  try {
    await ensureTables(db);
    await db`insert into app_subscriptions (mall_id, order_no, payment_type, price, until_ts)
             values (${String(opts.mallNo)}, ${opts.orderNo ?? ''}, ${opts.paymentType}, ${opts.price}, ${opts.untilTs})`;
    return true;
  } catch {
    return false;
  } finally {
    await db.end();
  }
}

export async function clearEntitlement(mallNo: number): Promise<void> {
  const db = sql();
  if (!db) return;
  try {
    await ensureTables(db);
    await db`delete from app_entitlement where mall_id = ${String(mallNo)}`;
  } catch {
    /* noop */
  } finally {
    await db.end();
  }
}

/** 결제/연장 처리 직후 상태 캐시를 선반영해 다음 상태 조회까지의 공백을 없앤다. */
export async function markEntitlement(mallNo: number, status: string, expireTs: Date | null): Promise<void> {
  const db = sql();
  if (!db) return;
  try {
    await ensureTables(db);
    await db`insert into app_entitlement (mall_id, app_status, expire_ts, checked_at)
             values (${String(mallNo)}, ${status}, ${expireTs}, now())
             on conflict (mall_id) do update
               set app_status = excluded.app_status, expire_ts = excluded.expire_ts, checked_at = now()`;
  } catch {
    /* noop */
  } finally {
    await db.end();
  }
}

/**
 * 몰의 현재 자격을 판정한다.
 * fetch: workspace 상태를 다시 조회할지 (기본 true — 캐시 TTL 내면 재조회 안 함)
 * accessToken: status 조회용 몰 토큰. 없으면 workspace 조회를 건너뛰고 DB 캐시/구독만 본다.
 */
export async function getEntitlement(mallNo: number, accessToken?: string | null, fetch = true): Promise<Entitlement> {
  const db = sql();
  if (!db) {
    // DB 없음 → workspace 직접 조회(캐시 없음). ACTIVE면 plus(구독 기록이 없으므로 workspace 기준).
    if (fetch && accessToken) {
      const { fetchAppStatus } = await import('@/lib/payment');
      const st = await fetchAppStatus(accessToken);
      const paid = st.kind === 'ACTIVE';
      return {
        paid,
        mode: paid ? 'plus' : 'free',
        status: st.kind,
        expireAt: st.kind === 'ACTIVE' ? st.expireDateTime ?? null : null,
        checkedAt: Date.now(),
      };
    }
    return { ...FREE, status: 'UNKNOWN', expireAt: null, checkedAt: Date.now() };
  }

  try {
    await ensureTables(db);

    // 1) workspace 상태 (캐시 TTL)
    let status: AppStatusKind = 'UNKNOWN';
    let expireTs: Date | null = null;
    const [ent] = await db<{ app_status: string; expire_ts: Date | null; checked_at: Date }[]>
      `select app_status, expire_ts, checked_at from app_entitlement where mall_id = ${String(mallNo)}`;
    const fresh = ent && Date.now() - new Date(ent.checked_at).getTime() < STATUS_TTL_MS;

    if (fetch && accessToken && !fresh) {
      const { fetchAppStatus } = await import('@/lib/payment');
      const st = await fetchAppStatus(accessToken);
      status = st.kind;
      const exp = st.kind === 'ACTIVE' || st.kind === 'EXPIRED' ? new Date(st.expireDateTime ?? '') : null;
      expireTs = exp && !Number.isNaN(exp.getTime()) ? exp : null;
      if (status !== 'UNKNOWN') {
        await db`insert into app_entitlement (mall_id, app_status, expire_ts, checked_at)
                 values (${String(mallNo)}, ${status}, ${expireTs}, now())
                 on conflict (mall_id) do update
                   set app_status = excluded.app_status, expire_ts = excluded.expire_ts, checked_at = now()`;
      }
    } else if (ent) {
      status = (ent.app_status as AppStatusKind) || 'UNKNOWN';
      expireTs = ent.expire_ts;
    }

    // 2) 활성 구독 (paid 판정 근거)
    const [sub] = await db<{ until_ts: Date }[]>
      `select until_ts from app_subscriptions where mall_id = ${String(mallNo)} and until_ts > now() order by until_ts desc limit 1`;
    const hasActiveSub = !!sub;

    // paid 규칙: workspace가 실행 차단(EXPIRED/DELETED)이 아니고, 우리가 기록한 활성 결제/체험이 있어야 plus.
    // UNKNOWN(판매앱 미전환·조회 실패)이어도 우리 extend로 기록한 결제는 유효 처리(심사·실제 결제 경로).
    const blocked = status === 'EXPIRED' || status === 'DELETED';
    const effectivePaid = !blocked && hasActiveSub;

    return {
      paid: effectivePaid,
      mode: effectivePaid ? 'plus' : 'free',
      status,
      expireAt: effectivePaid
        ? (sub?.until_ts ?? expireTs)?.toISOString() ?? null
        : expireTs?.toISOString() ?? null,
      checkedAt: Date.now(),
    };
  } catch {
    return { ...FREE, status: 'UNKNOWN', expireAt: null, checkedAt: Date.now() };
  } finally {
    await db.end();
  }
}