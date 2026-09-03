'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseReviewFile, type ImportedReview as ParsedReview } from '@/lib/reviewImport';

type Product = { no: number; name: string };
type Quota = { used: number; limit: number; paid: boolean };
type ImportedReview = {
  import_key: string;
  article_sno: number | null;
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
  imported_at: string;
};
type PaymentInfo = {
  method?: string;
  bank?: string;
  account?: string;
  holder?: string;
  vatIncluded?: boolean;
  contactEmail?: string;
};
type Plan = {
  mode: 'plus' | 'free';
  status: 'ACTIVE' | 'EXPIRED' | 'DELETED' | 'UNKNOWN';
  expireAt: string | null;
  price: number;
  blockedBy: 'expired' | 'deleted' | null;
  /** 앱스토어 앱 상세 URL — 없으면 결제 문구를 링크 없이 보여준다. */
  storeUrl: string | null;
  /** 수동 계좌이체 결제 안내 — 계좌·금액·연락처 */
  payment?: PaymentInfo | null;
};
type Result = {
  stage?: string;
  dryRun?: boolean;
  count?: number;
  allowed?: number;
  paid?: boolean;
  sample?: { writer: string; content: string; option?: string | null; score?: number; createdAt?: string | null; imageUrl?: string | null }[];
  parsed?: number;
  written?: number;
  failed?: number;
  skipped?: number;
  freeRemaining?: number | null;
  quotaExceeded?: boolean;
  used?: number;
  error?: string;
};

type GoodsPayload = {
  mallNo: number;
  quota: Quota;
  plan: Plan;
  products: Product[];
  /** 만료/삭제 상태에서 godomall server API가 상품 목록을 거부할 때의 메시지 (SA0010 등) */
  goodsError?: string | null;
};

const SOURCES = [
  { value: 'coupang', label: '쿠팡' },
  { value: 'smartstore', label: '네이버 스마트스토어' },
  { value: 'etc', label: '기타' },
];

const PAGE_SIZE = 50;
// 한 요청에 보내는 리뷰 수. 고도몰 외부 리뷰 bulk는 최대 100건/호출(스펙)이라
// 50건 = 1회 호출로 끝나 Hobby 60초에 넉넉하다. 배치가 작을수록 요청이 끊겼을 때
// 중복될 수 있는 창도 작아진다 (고도몰 bulk 응답엔 "어느 행 성공"이 없어 멱등 재시도 불가).
const IMPORT_BATCH = 50;
// 삭제 API는 1건/호출이라(고도몰엔 bulk 삭제 엔드포인트가 없다) 서버리스 시간 제한을
// 넘기지 않게 한 요청당 50건만 보낸다 — 서버 MAX_DELETE와 일치.
const DELETE_CHUNK = 50;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/** 수동 계좌이체 결제 안내 블록 — plan.payment가 있으면 계좌/금액/연락처를 보여준다 */
function BankPay({ pay, price }: { pay: PaymentInfo; price: number }) {
  if (pay.method !== 'bank' || !pay.account) return null;
  const vatLabel = pay.vatIncluded ? `${price.toLocaleString()}원(부가세 포함)` : `${price.toLocaleString()}원(부가세 별도)`;
  return (
    <div className="mt-3 rounded border border-dashed border-neutral-300 bg-white p-3 text-[11px] text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      <p className="font-medium text-neutral-900 dark:text-neutral-100">계좌이체로 결제 — 월 {vatLabel}</p>
      <p className="mt-1">
        입금 계좌: <span className="font-semibold">{pay.bank} {pay.account}</span> (예금주 {pay.holder})
      </p>
      <p className="mt-1">
        이체 후 {pay.contactEmail ?? '판매사'}로 입금자명을 알려주시면 확인 후 무제한으로 전환해 드립니다.
        <br />세금계산서가 필요하시면 이체와 함께 요청해 주세요.
      </p>
    </div>
  );
}

function PlanCard({ quota, plan }: { quota: Quota | null; plan: Plan | null }) {
  const price = plan?.price ?? 9900;
  const pay = plan?.payment;

  if (plan?.mode === 'plus') {
    return (
      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">리뷰이사 플러스 — 무제한 이용 중</p>
        {plan.expireAt && (
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">다음 결제일(만료): {fmtDate(plan.expireAt)} — 연장 결제 후 계속 이용하세요.</p>
        )}
        {pay && <BankPay pay={pay} price={price} />}
      </div>
    );
  }

  const used = Math.min(quota?.used ?? 20, quota?.limit ?? 20);
  const limit = quota?.limit ?? 20;

  if (plan?.blockedBy === 'expired' || plan?.blockedBy === 'deleted') {
    return (
      <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-950/40">
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">
          {plan.blockedBy === 'deleted' ? '앱이 삭제된 상태입니다. 다시 설치해 주세요.' : '유료 플랜 이용 기간이 끝났습니다.'}
        </p>
        <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">
          리뷰이사 플러스(월 {price.toLocaleString()}원)를 연장하면 다시 이용할 수 있습니다.
        </p>
        {pay && <BankPay pay={pay} price={price} />}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-neutral-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <p className="text-sm font-medium dark:text-neutral-100">
        {used >= limit ? '무료 20건(쇼핑몰당)을 모두 사용했어요' : `무료 ${limit}건 중 ${used}건 사용`}
      </p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-700">
        <div className="h-1.5 rounded-full bg-black transition-all dark:bg-white" style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        {used >= limit
          ? '리뷰이사 플러스(월 9,900원, 부가세 포함)로 전환하면 무제한으로 쓸 수 있어요. 아래 계좌로 이체 후 입금자명을 알려주세요.'
          : '쇼핑몰당 무료 20건까지 옮겨볼 수 있어요. 그 이상은 리뷰이사 플러스(월 9,900원)로 무제한.'}
      </p>
      {pay && used >= limit && <BankPay pay={pay} price={price} />}
    </div>
  );
}

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [mallName, setMallName] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goodsError, setGoodsError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState<number | ''>('');
  const [source, setSource] = useState('coupang');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [importProgress, setImportProgress] = useState<{
    written: number;
    total: number;
    failed: number;
    resuming: boolean;
  } | null>(null);
  const [imports, setImports] = useState<ImportedReview[] | null>(null);
  const [importedError, setImportedError] = useState('');
  const [importedMsg, setImportedMsg] = useState('');
  const [filterProduct, setFilterProduct] = useState<number | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delBusy, setDelBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [parsed, setParsed] = useState<ParsedReview[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showNotice, setShowNotice] = useState(false);

  useEffect(() => {
    fetch('/api/goods')
      .then((r) => r.json())
      .then((d: GoodsPayload) => {
        if (d.mallNo) setMallName(`몰 #${d.mallNo}`);
        if (d.quota) setQuota(d.quota);
        if (d.plan) setPlan(d.plan);
        if (d.goodsError) setGoodsError(d.goodsError);
        if (Array.isArray(d.products)) setProducts(d.products);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadImports = useCallback(async (pageNum: number, productNo: number | '') => {
    setImportedError('');
    setImportedMsg('');
    const q = new URLSearchParams();
    if (productNo) q.set('product_no', String(productNo));
    q.set('page', String(pageNum));
    q.set('page_size', String(PAGE_SIZE));
    fetch(`/api/imports?${q}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? '목록을 불러오지 못했습니다.');
        setImports(d.reviews ?? []);
        setTotal(d.total ?? 0);
        setPage(d.page ?? 1);
      })
      .catch((e: Error) => {
        setImportedError(e.message);
        setImports([]);
        setTotal(0);
      });
  }, []);

  useEffect(() => {
    // 최초 마운트 시 1회 로드 — 로딩 상태로 시작하는 것이 의도된 동작이다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadImports(1, '');
  }, [loadImports]);

  useEffect(() => {
    // 앱 안정성 안내 팝업 — 같은 브라우저 세션에서는 한 번만 띄운다.
    let seen = false;
    try {
      seen = sessionStorage.getItem('godo-notice-seen') === '1';
    } catch {}
    if (!seen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowNotice(true);
    }
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** localStorage에 이어올 지점을 남긴다. 같은 파일·상품이면 중단 지점부터 계속한다. */
  const resumeKey = useCallback(
    (productNo: number | '', f: File | null) => {
      if (!f) return '';
      return `godo-import:${mallName}:${productNo}:${f.name}:${f.size}:${f.lastModified}`;
    },
    [mallName],
  );
  const readResume = (key: string) => {
    try {
      const n = Number(localStorage.getItem(key) ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      // iframe·비공개 모드 등에서 저장소 접근이 거부되면(에러) 재개 없이 처음부터.
      return 0;
    }
  };

  async function run(dry: boolean) {
    if (!file) {
      setResult({ stage: 'no-file', error: '엑셀 파일을 먼저 선택해 주세요.' });
      return;
    }
    if (!productNo) {
      setResult({ stage: 'no-product', error: '어느 상품에 옮길지 먼저 선택해 주세요.' });
      return;
    }
    setBusy(true);
    setParsing(!parsed);
    setResult(null);

    let reviews = parsed;
    if (!reviews) {
      try {
        // 파싱은 동기라 큰 엑셀은 몇 초 걸린다. 그 사이 화면이 멈춘 것처럼 보이지 않게
        // 먼저 "읽는 중" 상태를 그려주고, 이벤트 루프에 양보한 뒤 파싱한다.
        await new Promise((r) => setTimeout(r, 0));
        const buf = await file.arrayBuffer();
        const r = parseReviewFile(buf);
        reviews = r.reviews;
        setParsed(reviews);
      } catch (e) {
        setResult({ stage: 'parse', error: (e as Error).message });
        setBusy(false);
        setParsing(false);
        return;
      }
    }
    setParsing(false);
    if (!reviews) return;

    if (dry) {
      const allowed = quota?.paid
        ? reviews.length
        : Math.max(0, (quota?.limit ?? 20) - (quota?.used ?? 0));
      setResult({
        dryRun: true,
        count: reviews.length,
        allowed,
        paid: quota?.paid,
        sample: reviews.slice(0, 3),
      });
      setBusy(false);
      return;
    }

    // 실제 이관 — IMPORT_BATCH건씩 배치로 나눠 진행한다.
    const rkey = resumeKey(productNo, file);
    let offset = readResume(rkey);
    if (offset >= reviews.length) offset = 0;
    const resuming = offset > 0;
    let totalWritten = 0;
    let totalFailed = 0;
    let quotaExhausted = false;
    let freeRemaining: number | null = quota?.paid
      ? null
      : Math.max(0, (quota?.limit ?? 20) - (quota?.used ?? 0));
    setImportProgress({ written: offset, total: reviews.length, failed: 0, resuming });

    try {
      while (offset < reviews.length && !quotaExhausted) {
        const slice = reviews.slice(offset, offset + IMPORT_BATCH);
        const res = await fetch('/api/reviews/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_no: productNo, source, reviews: slice }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 402) {
          // 무료 한도 소진 — 여기까지 기록된 것을 남기고 중단한다.
          quotaExhausted = true;
          saveProgress(rkey, offset);
          setResult({ quotaExceeded: true, used: json.used });
          setQuota((q) => (q ? { ...q, used: q.limit } : q));
          break;
        }
        if (!res.ok) throw new Error(json.error ?? '옮기는 중 문제가 생겼습니다.');
        const written = json.written ?? 0;
        const failed = json.failed ?? 0;
        // 성공·실패 모두 0이면 진행 지점이 안 움직여 같은 배치를 무한 재전송하게 된다.
        // (응답 본문이 비정상이거나 서버가 아무것도 처리하지 못한 경우) 중단하고 에러를 보인다.
        if (written === 0 && failed === 0)
          throw new Error('응답을 받지 못했습니다. 다시 「옮기기」를 눌러 이어서 진행해 주세요.');
        totalWritten += written;
        totalFailed += failed;
        // 소비된 리뷰만큼만 진행 지점을 옮긴다. 무료 한도에 걸려 안 옮겨진 건은
        // 유료 전환 후 이어서 할 수 있게 다음 offset부터 다시 보낸다.
        offset += written + failed;
        freeRemaining = json.freeRemaining ?? freeRemaining;
        if (!json.paid && typeof freeRemaining === 'number') {
          const remaining = freeRemaining;
          setQuota((q) => (q ? { ...q, used: Math.max(q.used, (q.limit ?? 20) - remaining) } : q));
        }
        saveProgress(rkey, offset);
        setImportProgress({ written: offset, total: reviews.length, failed: totalFailed, resuming });
        if (json.quotaExhausted) {
          quotaExhausted = true;
          setResult({ quotaExceeded: true, used: json.used });
          setQuota((q) => (q ? { ...q, used: q.limit } : q));
          break;
        }
      }
      if (!quotaExhausted) {
        // 전부 진행됨 — 이어올 지점을 지운다.
        try {
          localStorage.removeItem(rkey);
        } catch {
          // 저장소 접근이 거부되면 남은 진행 지점이 다음 번에 재개로 오인될 수 있지만,
          // offset >= reviews.length면 readResume이 0으로 되돌리므로 실제 영향은 없다.
        }
        const skipped = reviews.length - totalWritten - totalFailed;
        setResult({
          parsed: reviews.length,
          written: totalWritten,
          failed: totalFailed,
          skipped,
          freeRemaining,
          paid: quota?.paid,
        });
        if (!quota?.paid && typeof freeRemaining === 'number') {
          const used = (quota?.limit ?? 20) - freeRemaining;
          setQuota((q) => (q ? { ...q, used } : q));
        }
        setFilterProduct('');
        loadImports(1, '');
      } else {
        // 한도 소진으로 중단해도 여기까지 옮겨진 글은 목록에 보이게 한다.
        loadImports(1, filterProduct);
      }
    } catch (e) {
      // 중간 실패 — 진행 지점을 남겨 두어 다음 「옮기기」가 이어서 진행하게 한다.
      saveProgress(rkey, offset);
      setResult({
        stage: 'write',
        parsed: reviews.length,
        written: totalWritten,
        failed: totalFailed,
        error: (e as Error).message,
      });
    } finally {
      setBusy(false);
      setImportProgress(null);
    }
  }

  function saveProgress(key: string, offset: number) {
    try {
      localStorage.setItem(key, String(offset));
    } catch {
      // 저장소 접근이 거부되면(iframe·비공개 모드) 재개 지점을 못 남기지만 진행은 계속한다.
    }
  }

  async function deleteImports(snos: number[]) {
    if (!snos.length || delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      for (let i = 0; i < snos.length; i += DELETE_CHUNK) {
        const chunk = snos.slice(i, i + DELETE_CHUNK);
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ article_snos: chunk }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
      }
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
      if (totalDeleted) {
        // 마지막 페이지의 글을 다 지웠다면 page가 새 마지막 페이지를 넘어 "3/2페이지"처럼
        // 빈 목록이 보이지 않게, 삭제 후 총건수로 계산한 마지막 페이지로 조정한다.
        const remaining = Math.max(0, total - totalDeleted);
        const lastPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
        await loadImports(Math.min(page, lastPage), filterProduct);
        setSelected(new Set());
      }
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
    }
  }

  /** 현재 필터의 모든 옮긴 리뷰를 고도몰에서 지우고 원장도 정리한다. 서버가 hasMore로 순회한다. */
  async function deleteAllFiltered() {
    if (
      !window.confirm(
        '현재 필터(전체 상품 포함)의 모든 리뷰를 삭제할까요? 쇼핑몰 게시판에서도 함께 삭제됩니다.',
      )
    )
      return;
    if (delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      let hasMore = true;
      while (hasMore) {
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true, product_no: filterProduct || undefined }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        hasMore = !!json.hasMore;
      }
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
      if (totalDeleted) {
        await loadImports(1, filterProduct);
        setSelected(new Set());
      }
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
    }
  }

  async function useSample() {
    const blob = await fetch('/sample-reviews.xlsx').then((r) => r.blob());
    setFile(new File([blob], 'sample-reviews.xlsx', { type: blob.type }));
    setParsed(null);
    setResult(null);
  }

  if (loading)
    return (
      <main className="p-8 text-sm text-neutral-500 dark:text-neutral-400">
        <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border border-neutral-400 border-t-transparent align-[-1px]" />
        몰 정보를 불러오는 중입니다…
      </main>
    );

  if (!mallName)
    return <main className="p-8 text-sm dark:text-neutral-300">고도몰 관리자에서 앱을 실행해 주세요.</main>;

  return (
    <main className="p-6 font-sans">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-lg font-semibold dark:text-neutral-100">리뷰 옮기기</h1>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{mallName}</p>

      {goodsError && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          상품 목록을 불러오지 못했습니다: {goodsError}
        </p>
      )}

      <ol className="mt-6 space-y-5 text-sm">
        <li>
          <div className="font-medium dark:text-neutral-100">1. 리뷰 엑셀과 출처를 준비하세요</div>
          <div className="mt-2">
            <select
              className="w-full rounded border p-2 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}에서 온 리뷰</option>
              ))}
            </select>
          </div>
        </li>

        <li className={result?.stage === 'no-product' ? 'rounded-lg ring-2 ring-amber-400/70' : ''}>
          <div className="font-medium dark:text-neutral-100">2. 어느 상품에 넣을지 고르세요</div>
          <select
            className="mt-2 w-full rounded border p-2 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            value={productNo}
            onChange={(e) => {
              const v = Number(e.target.value) || '';
              setProductNo(v);
              // 미선택 안내가 떠 있으면 고르는 순간 지운다.
              setResult(null);
            }}
          >
            <option value="">상품 선택</option>
            {products.map((p) => (
              <option key={p.no} value={p.no}>
                [{p.no}] {p.name}
              </option>
            ))}
          </select>
        </li>

        <li className={result?.stage === 'no-file' ? 'rounded-lg ring-2 ring-amber-400/70' : ''}>
          <div className="font-medium dark:text-neutral-100">3. 엑셀 파일을 올리세요</div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setParsed(null);
              setResult(null);
              // 같은 파일을 다시 골라도 onChange가 다시 발동하게 value를 비운다.
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || parsing}
            className="mt-2 inline-block rounded border px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            파일 선택
          </button>
          <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            엑셀이 아직 없다면{' '}
            <button onClick={useSample} className="underline">샘플 엑셀로 체험하기</button>
            {' · '}
            <a href="/sample-reviews.xlsx" className="underline">샘플 내려받기</a>
          </div>
          {file && (
            <div className="mt-1 text-xs font-medium text-green-700 dark:text-green-400">
              ✓ 선택된 파일: {file.name}
            </div>
          )}
        </li>
      </ol>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => run(true)}
          disabled={busy || parsing}
          className="rounded border px-4 py-2 text-sm disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300"
        >
          미리보기
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy || parsing}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          {busy && importProgress
            ? `옮기는 중 ${Math.round(
                importProgress.total > 0 ? (importProgress.written / importProgress.total) * 100 : 0,
              )}%…`
            : busy || parsing
              ? '읽는 중…'
              : '옮기기'}
        </button>
      </div>

      {!busy && !parsing && (!file || !productNo) && (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {!file ? '① 엑셀 파일을 선택하고, ② 상품을 고르면 버튼을 누를 수 있어요.' : '② 상품을 먼저 선택해 주세요.'}
        </p>
      )}

      {parsing && (
        <div className="mt-4 rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <div className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-400 border-t-transparent align-[-1px] dark:border-neutral-500" />
            <span className="font-medium">엑셀을 읽는 중입니다…</span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            리뷰가 많으면 몇 초 걸릴 수 있습니다. 화면이 잠깐 멈춘 것처럼 보여도 기다리시면 됩니다.
          </p>
        </div>
      )}

      {importProgress && (
        <div className="mt-4 rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <div className="flex justify-between text-neutral-600 dark:text-neutral-300">
            <span>
              옮기는 중 {Math.min(importProgress.written, importProgress.total)} /{' '}
              {importProgress.total}건
              {importProgress.resuming ? ' (이어서 진행)' : ''}
              {importProgress.failed > 0 ? ` · 실패 ${importProgress.failed}건` : ''}
            </span>
            <span className="font-semibold">
              {importProgress.total > 0
                ? `${Math.round((importProgress.written / importProgress.total) * 100)}%`
                : '0%'}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-700">
            <div
              className="h-1.5 rounded-full bg-black transition-all dark:bg-white"
              style={{
                width: `${
                  importProgress.total > 0
                    ? Math.min(100, Math.round((importProgress.written / importProgress.total) * 100))
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            한 번에 {IMPORT_BATCH}건씩 나눠 옮겨서, 1만 건도 끊기지 않게 진행합니다. 중간에
            멈추면 이 화면에서 다시 눌러 이어서 하세요.
          </p>
        </div>
      )}

      <PlanCard quota={quota} plan={plan} />

      <p className="mt-8 border-t pt-4 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        쇼핑몰당 무료 20건 · 리뷰이사 플러스(무제한) 월 9,900원(부가세 포함){' · '}
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>

      {result && (
        <div className="mt-6 rounded bg-neutral-50 p-4 text-sm dark:bg-neutral-800/60">
          {result.quotaExceeded ? (
            <PlanCard quota={quota} plan={plan} />
          ) : result.stage === 'no-file' || result.stage === 'no-product' ? (
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {result.stage === 'no-file'
                  ? '엑셀 파일을 먼저 선택해 주세요.'
                  : '어느 상품에 옮길지 먼저 선택해 주세요.'}
              </p>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                {result.stage === 'no-file'
                  ? '아래 ① 상자(노란색 테두리)에서 엑셀 파일을 고르면 바로 진행할 수 있어요.'
                  : '아래 ② 상자(노란색 테두리)에서 옮길 상품을 고르면 바로 진행할 수 있어요.'}
              </p>
            </div>
          ) : result.error ? (
            <p className="text-red-600">
              {result.stage === 'parse'
                ? '엑셀을 읽지 못했습니다. 구매평 엑셀 파일이 맞는지 확인해 주세요.'
                : '옮기는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.'}
              <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{result.error}</span>
              {result.stage === 'write' && typeof result.written === 'number' ? (
                <span className="mt-2 block text-xs text-neutral-600 dark:text-neutral-400">
                  여기까지 {result.written}건은 옮겨져 목록에 남아 있습니다. 「옮기기」를 다시
                  누르면 이어서 진행됩니다.
                </span>
              ) : null}
            </p>
          ) : result.dryRun ? (
            <>
              <p className="font-medium dark:text-neutral-100">구매평 {result.count}건을 읽었습니다. 아래는 앞 3건입니다.</p>
              <ul className="mt-2 space-y-2 text-xs text-neutral-700 dark:text-neutral-300">
                {result.sample?.map((s, i) => (
                  <li key={i} className="rounded border bg-white p-2 dark:border-neutral-700 dark:bg-neutral-800">
                    <span className="font-medium">{s.writer}</span>
                    {s.score ? <span className="text-amber-500"> ★{s.score}</span> : null}
                    {s.createdAt && <span className="text-neutral-400 dark:text-neutral-500"> {s.createdAt}</span>}
                    {' — '}{s.content}
                    {s.option && <span className="text-neutral-500 dark:text-neutral-400"> [옵션] {s.option}</span>}
                    {s.imageUrl && (
                      <span className="mt-1 block">
                        <a href={s.imageUrl} target="_blank" rel="noreferrer" className="underline">첨부 이미지</a>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!result.paid && (result.count ?? 0) > (result.allowed ?? Infinity) ? (
                <div className="mt-2">
                  <PlanCard quota={quota} plan={plan} />
                </div>
              ) : (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  아직 아무것도 등록되지 않았습니다. 「옮기기」를 누르면 실제로 등록됩니다.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="font-medium dark:text-neutral-100">구매평 {result.written}건을 옮겼습니다.</p>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                이제 상품 상세페이지에서 확인할 수 있습니다.
              </p>
              {(result.failed ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  (고도몰에서 거부된 {result.failed}건은 건너뛰었습니다)
                </p>
              ) : null}
              {!result.paid && (result.skipped ?? 0) > 0 ? (
                <div className="mt-2">
                  <PlanCard quota={quota} plan={plan} />
                </div>
              ) : (result.skipped ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">(건너뜀 {result.skipped}건)</p>
              ) : null}
            </>
          )}
        </div>
      )}

      {/* 리뷰이사가 옮긴 리뷰 관리 — 옮긴 글을 기록해 두고 필터·삭제할 수 있다 */}
      <div className="mt-8 border-t pt-4 dark:border-neutral-700">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold dark:text-neutral-100">리뷰이사가 옮긴 리뷰 관리</h2>
          <button
            onClick={() => loadImports(page, filterProduct)}
            className="rounded border px-3 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            새로고침
          </button>
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          삭제하면 쇼핑몰 게시판에서도 함께 지워집니다. 목록은 {PAGE_SIZE}건씩 보여드립니다.
          새로 옮긴 리뷰는 바로 여기 나타납니다.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded border p-1.5 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            value={filterProduct}
            onChange={(e) => {
              const v = Number(e.target.value) || '';
              setFilterProduct(v);
              loadImports(1, v);
            }}
          >
            <option value="">전체 상품</option>
            {products.map((p) => (
              <option key={p.no} value={p.no}>
                [{p.no}] {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              deleteImports(
                (imports ?? [])
                  .filter((r) => r.article_sno != null && selected.has(r.import_key))
                  .map((r) => r.article_sno as number),
              )
            }
            disabled={delBusy || selected.size === 0}
            className="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            선택 삭제 ({selected.size})
          </button>
          <button
            onClick={deleteAllFiltered}
            disabled={delBusy || total === 0}
            className="rounded border px-3 py-1.5 text-xs text-red-600 disabled:opacity-40 dark:border-neutral-600 dark:text-red-400"
          >
            전체 삭제 ({total}건)
          </button>
          {delBusy && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              삭제하는 중…
            </span>
          )}
        </div>

        {importedError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{importedError}</p>}
        {importedMsg && <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{importedMsg}</p>}

        {imports === null ? (
          <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">목록을 불러오는 중입니다…</p>
        ) : imports.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
            기록된 리뷰가 없습니다. (새로 옮긴 리뷰부터 표시됩니다)
          </p>
        ) : (
          <>
            <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto text-xs">
              {imports.map((r) => {
                const pname = products.find((p) => p.no === r.goods_no)?.name ?? `상품 ${r.goods_no}`;
                const confirmed = r.article_sno != null;
                return (
                  <li key={r.import_key} className="flex items-start gap-2 rounded border bg-white p-2 dark:border-neutral-700 dark:bg-neutral-800">
                    <input
                      type="checkbox"
                      checked={selected.has(r.import_key)}
                      disabled={!confirmed}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.import_key);
                          else next.delete(r.import_key);
                          return next;
                        })
                      }
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-neutral-800 dark:text-neutral-200">
                        <span className="font-medium">{pname}</span>
                        <span className="text-amber-500"> ★{r.score}</span>
                        {' · '}
                        <span>{r.writer}</span>
                      </div>
                      <div className="mt-0.5 text-neutral-400 dark:text-neutral-500">
                        {confirmed ? `글번호 ${r.article_sno}` : '등록 확인 안 됨 (게시판 반영 전)'}
                        {r.created_date ? ` · 원 작성일 ${r.created_date}` : ''}
                        {' · '}옮긴 시각 {new Date(r.imported_at).toLocaleString('ko-KR')}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
              <span>
                {total}건 중 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}건 ·{' '}
                {page}/{totalPages}페이지
              </span>
              <span className="flex gap-1">
                <button
                  onClick={() => loadImports(page - 1, filterProduct)}
                  disabled={page <= 1}
                  className="rounded border px-2 py-0.5 disabled:opacity-40 dark:border-neutral-600"
                >
                  이전
                </button>
                <button
                  onClick={() => loadImports(page + 1, filterProduct)}
                  disabled={page >= totalPages}
                  className="rounded border px-2 py-0.5 disabled:opacity-40 dark:border-neutral-600"
                >
                  다음
                </button>
              </span>
            </div>
          </>
        )}
      </div>
      </div>

      {/* 프로모션 — 데스크톱(xl 이상)에서는 오른쪽에 떠 있고, 그보다 좁은 화면에서는 폼 아래로 내려온다 */}
      <aside className="mt-8 rounded-lg border border-neutral-300 bg-white p-4 md:mx-auto md:w-full md:max-w-xl xl:fixed xl:right-6 xl:top-6 xl:z-10 xl:mx-0 xl:mt-0 xl:w-64 xl:max-w-none dark:border-neutral-700 dark:bg-neutral-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          리뷰이사 추천
        </p>
        <p className="mt-2 text-sm font-semibold dark:text-neutral-100">ReviewBoost 리뷰 수집기</p>
        <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          쿠팡·스마트스토어 상품 페이지에서 그 상품의 리뷰를 버튼 한 번으로 엑셀(.xlsx)로
          내려받는 무료 브라우저 확장 프로그램입니다. 스마트스토어 판매자센터 공식 리뷰 엑셀
          25열 형식으로 저장되어 이 앱에 그대로 올릴 수 있어요. (무료 분석 리포트 연동도
          지원합니다)
        </p>
        <a
          href="https://chromewebstore.google.com/detail/kdmjkpfbccikgbaemcbifemeichmehlm"
          target="_blank"
          rel="noreferrer"
          className="mt-3 block rounded bg-black px-4 py-2 text-center text-sm text-white dark:bg-white dark:text-black"
        >
          Chrome 웹스토어에서 설치하기
        </a>
        <p className="mt-2 text-[11px] text-neutral-400 dark:text-neutral-500">무료 · Chrome/Edge/웨일 지원</p>
      </aside>

      {/* 앱 안정성 안내 팝업 — 문제 시 이메일로 문의 */}
      {showNotice && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg border border-neutral-300 bg-white p-5 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
            <h2 className="text-base font-semibold dark:text-neutral-100">안내</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              앱이 불안정할 수 있습니다. 이관 중 문제가 발생하면 아래 이메일로 문의해 주세요.
            </p>
            <a
              href="mailto:kwan765@naver.com"
              className="mt-4 inline-block rounded bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black"
            >
              kwan765@naver.com 으로 문의
            </a>
            <button
              onClick={() => {
                try {
                  sessionStorage.setItem('godo-notice-seen', '1');
                } catch {}
                setShowNotice(false);
              }}
              className="mt-3 block w-full rounded border px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </main>
  );
}