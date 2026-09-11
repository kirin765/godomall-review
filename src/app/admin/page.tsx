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
  /** 저장 공간 부족으로 사진 없이 등록된 글. */
  photo_dropped: boolean;
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
  sample?: { writer: string; content: string; option?: string | null; score?: number; createdAt?: string | null; images?: string[] }[];
  parsed?: number;
  written?: number;
  failed?: number;
  /** 저장 공간 부족으로 사진을 빼고 등록한 건수 — 고객 안내용 */
  photoDropped?: number;
  /** 재시도로 풀리지 않는 오류로 끝난 건수 — 고객 안내용 */
  permanentFailed?: number;
  /** 이미 옮겨진(게시판 확인된) 리뷰로 재전송에서 건너뛴 건수 */
  already?: number;
  skipped?: number;
  freeRemaining?: number | null;
  quotaExceeded?: boolean;
  used?: number;
  error?: string;
};

/**
 * 마지막 이관 요약 — 원장은 성공분만 담으므로 "아직 등록되지 않은 리뷰"가 몇 건인지는
 * 파일(파싱 결과)과 대조해야만 알 수 있다. 브라우저(localStorage)에 남겨 보여준다.
 */
type LastRun = {
  productNo: number | '';
  productName: string;
  fileName: string;
  parsed: number;
  /** 이전 실행에서 이어하기로 이미 끝난 구간(이번 실행에서 dispatch되지 않아 results에 없다). */
  resumed: number;
  written: number;
  already: number;
  failed: number;
  /** 아직 게시판에 등록되지 않은 건수 = parsed - resumed - written - already. */
  notRegistered: number;
  /** 사진(첨부)이 거부돼 사진 없이 등록된 건수. */
  photoDropped: number;
  at: number;
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
// 중복될 수 있는 창도 작아진다. 서버가 내용 해시로 "게시판에 확인된" 중복을 걸러내므로
// (부분 멱등) 재전송돼도 확인된 글은 중복 등록되지 않는다.
const IMPORT_BATCH = 50;
// 배치 요청 클라이언트 타임아웃. 서버 함수가 60초 제한에 죽거나 응답이 늦어도
// 화면이 무한 대기하지 않게 넉넉히 끊는다(끊겨도 재개 지점이 남고, 재전송은 서버가 걸러낸다).
const BATCH_FETCH_TIMEOUT_MS = 70000;
// 성공 배치를 다시 보내기 전 배치 사이 잠깐 쉰다 — 서버 예산·회복 시간을 존중한다.
const RETRY_PAUSE_MS = 5000;
// 진행 없이 실패가 이어질 때 물러나 기다리는 시간(30→60→120초에서 머문다).
// 일시적 오류·점검으로 막혀도 회복되는 대로 바로 이어간다. 사용자는 「정지」로 멈춘다.
const BACKOFF_STEPS_MS = [30000, 60000, 120000];
// 삭제 요청 클라이언트 타임아웃. 서버가 함수 예산(45초) 안에서 반드시 응답하므로
// 여유를 두고 끊는다 — "삭제하는 중…"에 갇히지 않게.
const DELETE_FETCH_TIMEOUT_MS = 70000;
// 삭제 API는 1건/호출이라(고도몰엔 bulk 삭제 엔드포인트가 없다) 서버리스 시간 제한을
// 넘기지 않게 한 요청당 50건만 보낸다 — 서버 MAX_DELETE와 일치.
const DELETE_CHUNK = 50;

/** localStorage에 마지막 이관 요약을 남기는 키. */
const lastRunKey = (mall: string) => `godo-lastrun:${mall}`;

/**
 * 백오프 대기 — ms 동안 기다리면서 1초마다 남은 시간을 onTick으로 알린다.
 * checkStop()이 참을 내면 일찍 끝난다(정지·한도 소진 등).
 */
async function backoffWait(ms: number, checkStop: () => boolean, onTick: (sec: number) => void) {
  const until = Date.now() + ms;
  while (until > Date.now() && !checkStop()) {
    onTick(Math.ceil((until - Date.now()) / 1000));
    await new Promise((r) => setTimeout(r, 1000));
  }
}

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

/**
 * 저장 공간 부족으로 사진이 빠진 채 등록됐을 때의 안내.
 * 자료실·첨부 용량을 늘린 뒤 「사진 빠진 리뷰만」에서 삭제하고 같은 엑셀을 다시 올리면 사진이 포함된다.
 */
function PhotoDroppedNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
      <p className="font-medium text-amber-900 dark:text-amber-300">
        사진 없이 등록된 리뷰가 {count}건 있어요
      </p>
      <p className="mt-1 text-amber-800 dark:text-amber-400">
        쇼핑몰의 저장 공간(첨부 용량)이 부족해 사진이 거부된 것입니다. [관리자]에서 저장 공간을 늘린 뒤,
        「사진 빠진 리뷰만」에서 해당 리뷰를 삭제하고 같은 엑셀을 다시 옮기면 사진이 포함되어 등록됩니다.
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
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [importProgress, setImportProgress] = useState<{
    written: number;
    total: number;
    failed: number;
    resuming: boolean;
    /** 백오프 대기 중 — N초 뒤 자동으로 이어서 재시도합니다. */
    retrying: number | null;
  } | null>(null);
  const [imports, setImports] = useState<ImportedReview[] | null>(null);
  const [importedError, setImportedError] = useState('');
  const [importedMsg, setImportedMsg] = useState('');
  const [filterProduct, setFilterProduct] = useState<number | ''>('');
  const [filterPhotoDropped, setFilterPhotoDropped] = useState(false);
  const [photoDroppedTotal, setPhotoDroppedTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delBusy, setDelBusy] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ deleted: number; total: number; failed: number } | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [parsed, setParsed] = useState<ParsedReview[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  // 이관 중 「정지」를 눌렀음을 기록한다 — run(진행 루프)이 이를 보고 깨끗하게 멈춘다.
  const stopRef = useRef(false);
  // 이관 중 화면이 잠자지 않게(Sleep 방지) Wake Lock을 잡는다.
  const wakeLockRef = useRef<Awaited<ReturnType<Navigator['wakeLock']['request']>> | null>(null);

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

  const loadImports = useCallback(async (pageNum: number, productNo: number | '', photoDroppedOnly = false) => {
    setImportedError('');
    setImportedMsg('');
    const q = new URLSearchParams();
    if (productNo) q.set('product_no', String(productNo));
    if (photoDroppedOnly) q.set('photo_dropped', '1');
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

  /** 사진 누락(photo_dropped) 건수 — 안내 표시·재이관 가드에 쓴다. */
  const photoDroppedCount = useCallback(async (productNo: number | ''): Promise<number> => {
    const q = new URLSearchParams({ photo_dropped: '1', page: '1', page_size: '1' });
    if (productNo) q.set('product_no', String(productNo));
    try {
      const res = await fetch(`/api/imports?${q}`);
      if (!res.ok) return 0;
      const d = await res.json();
      return Number(d.total ?? 0);
    } catch {
      return 0;
    }
  }, []);

  useEffect(() => {
    // 최초 마운트 시 1회 로드 — 로딩 상태로 시작하는 것이 의도된 동작이다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadImports(1, '');
  }, [loadImports]);

  useEffect(() => {
    // 사진 누락 건수 — 안내·재이관 가드용. 실패해도 화면은 그대로 둔다.
    photoDroppedCount('').then(setPhotoDroppedTotal);
  }, [photoDroppedCount]);

  useEffect(() => {
    // 지난 이관 요약 — 원장은 성공분만 담으므로 미등록 건수를 여기서 알려준다.
    try {
      const raw = localStorage.getItem(lastRunKey(mallName));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setLastRun(JSON.parse(raw) as LastRun);
    } catch {}
  }, [mallName]);

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
    // 이관이 수십 분 걸릴 수도 있으므로 화면이 잠자지 않게 Wake Lock을 잡는다.
    stopRef.current = false;
    try {
      wakeLockRef.current = 'wakeLock' in navigator ? await navigator.wakeLock.request('screen') : null;
    } catch {}

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

    // 사진 빠진 리뷰 재이관 가드 — 저장 공간을 늘리지 않고 다시 옮기면 같은 리뷰가
    // 중복 등록될 수 있다. 남아 있으면 먼저 지울지 확인하고, 동의하면 지운 뒤 이어간다.
    const droppedNow = await photoDroppedCount(productNo);
    if (droppedNow > 0) {
      const proceed = window.confirm(
        `사진 없이 등록된 리뷰가 ${droppedNow}건 있습니다.\n` +
          '저장 공간을 늘리셨다면 먼저 삭제한 뒤 재이관해야 사진이 포함되어 등록됩니다.\n' +
          '「확인」을 누르면 삭제 후 이어서 옮깁니다. (「취소」하면 그대로 진행합니다.)',
      );
      if (proceed) {
        const ok = await deletePhotoDroppedForProduct(productNo, droppedNow);
        if (!ok) {
          setBusy(false);
          return;
        }
      }
    }

    // 실제 이관 — IMPORT_BATCH건씩 배치로 보내고, 실패 배치는 자동으로 이어서 재시도한다.
    // 한 번 누르면 끝날 때까지 진행하며(2026-09), 성공분은 배치마다 즉시 원장에 남아
    // 목록·삭제에서 복구된다. 재전송분은 서버가 내용 해시로 걸러 중복을 막는다(부분 멱등).
    const rkey = resumeKey(productNo, file);
    const batchCount = Math.ceil(reviews.length / IMPORT_BATCH);
    let resumeIdx = Math.floor(readResume(rkey) / IMPORT_BATCH);
    if (resumeIdx >= batchCount) resumeIdx = 0;
    // 이전 실행에서 완료된 구간(이번 실행에서 dispatch되지 않아 results에 안 잡힌다).
    // 요약의 "미등록" 계산에 이 값을 더해야 이어하기 때도 정확하다.
    const startResumeIdx = resumeIdx;
    const resuming = resumeIdx > 0;
    let attempted = resumeIdx * IMPORT_BATCH;
    let quotaExhausted = false;
    let usedNow = quota?.used ?? 0;
    const done = new Array<boolean>(batchCount).fill(false);
    const results: ({ written: number; failed: number; already: number } | null)[] =
      new Array(batchCount).fill(null);
    // 재시도로 풀리지 않는 오류로 끝난 배치 — 자동 이어하기에서 제외한다.
    const permanent = new Array<boolean>(batchCount).fill(false);
    const permanentCounts = new Array<number>(batchCount).fill(0);
    // 배치별 사진 누락 건수 — 재시도 응답으로 교체(중복 계산 방지)한다.
    const photoDroppedCounts = new Array<number>(batchCount).fill(0);
    let freeRemaining: number | null = quota?.paid
      ? null
      : Math.max(0, (quota?.limit ?? 20) - (quota?.used ?? 0));
    setImportProgress({ written: attempted, total: reviews.length, failed: 0, resuming, retrying: null });

    const saveProgressAndState = () => {
      saveProgress(rkey, Math.min(resumeIdx * IMPORT_BATCH, reviews.length));
      setImportProgress({
        written: Math.max(attempted, resumeIdx * IMPORT_BATCH),
        total: reviews.length,
        failed: results.reduce((s, r) => s + (r?.failed ?? 0), 0),
        resuming,
        retrying: null,
      });
    };
    const sliceLen = (idx: number) => Math.min(IMPORT_BATCH, reviews.length - idx * IMPORT_BATCH);
    const bumpAttempted = (idx: number) => {
      if (results[idx] === null) attempted += sliceLen(idx);
    };

    const onBatchDone = (
      idx: number,
      json: {
        written?: number;
        failed?: number;
        already?: number;
        photoDropped?: number;
        permanentFailed?: number;
        freeRemaining?: number | null;
        paid?: boolean;
        quotaExhausted?: boolean;
      },
    ) => {
      bumpAttempted(idx);
      // 실패가 전부 재시도 불가(영구)일 때만 이 배치의 자동 재시도를 멈춘다.
      const failedCount = json.failed ?? 0;
      permanentCounts[idx] = json.permanentFailed ?? 0;
      if (failedCount > 0 && permanentCounts[idx] >= failedCount) permanent[idx] = true;
      photoDroppedCounts[idx] = json.photoDropped ?? 0;
      if (json.freeRemaining !== undefined && json.freeRemaining !== null) {
        freeRemaining = json.freeRemaining;
        if (!json.paid) usedNow = (quota?.limit ?? 20) - freeRemaining;
      }
      if (json.quotaExhausted) {
        // 무료 한도가 배치 도중 소진 — 이 배치의 나머지는 아직 안 옮겨졌다. 완료 구간에
        // 넣지 않고 중단해, 유료 전환 후 이 배치부터 이어서 하게 둔다.
        quotaExhausted = true;
        saveProgress(rkey, resumeIdx * IMPORT_BATCH);
        setResult({ quotaExceeded: true, used: usedNow });
        setQuota((q) => (q ? { ...q, used: q.limit } : q));
        return;
      }
      results[idx] = { written: json.written ?? 0, failed: json.failed ?? 0, already: json.already ?? 0 };
      done[idx] = true;
      // 완료된 연속 구간만큼 재개 지점을 전진시킨다.
      while (resumeIdx < batchCount && done[resumeIdx]) resumeIdx++;
      saveProgressAndState();
    };

    /** 한 배치를 보낸다. 'ok'/'quota'/'err' 셋 중 하나로 돌아온다. */
    const sendOne = async (idx: number) => {
      const slice = reviews.slice(idx * IMPORT_BATCH, (idx + 1) * IMPORT_BATCH);
      try {
        const res = await fetch('/api/reviews/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 서버 함수가 60초 제한에 죽거나 응답이 없어도 연결을 끊어 화면이 갇히지 않게 한다.
          signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
          body: JSON.stringify({ product_no: productNo, source, reviews: slice }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 402) return { kind: 'quota' as const, json };
        if (!res.ok) return { kind: 'err' as const, msg: String(json.error ?? '옮기는 중 문제가 생겼습니다.') };
        // 200인데 아무 카운트도 없으면 본문 파싱 실패·서버 오류다. 이걸 "완료"로 세면 진행
        // 지점이 그 배치를 건너뛰어 유실되므로 에러로 본다(재시도·재개 대상).
        if (!json.written && !json.failed && !json.already)
          return {
            kind: 'err' as const,
            msg: '응답을 받지 못했습니다. 다시 「옮기기」를 눌러 이어서 진행해 주세요.',
          };
        return { kind: 'ok' as const, json };
      } catch (e) {
        return { kind: 'err' as const, msg: (e as Error).message };
      }
    };

    /** 실패한 배치를 자동 이어하기에서 다시 보낸다. 결과는 최종값으로 교체한다. */
    const sendRetry = async (idx: number): Promise<boolean> => {
      const slice = reviews.slice(idx * IMPORT_BATCH, (idx + 1) * IMPORT_BATCH);
      try {
        const res = await fetch('/api/reviews/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(BATCH_FETCH_TIMEOUT_MS),
          body: JSON.stringify({ product_no: productNo, source, reviews: slice }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          written?: number;
          failed?: number;
          already?: number;
          photoDropped?: number;
          permanentFailed?: number;
          freeRemaining?: number | null;
          paid?: boolean;
          quotaExhausted?: boolean;
        };
        if (res.status === 402 || json.quotaExhausted) {
          quotaExhausted = true;
          return false;
        }
        if (!res.ok) return false; // 재시도도 실패 — 그대로 둔다
        const retryFailed = json.failed ?? 0;
        permanentCounts[idx] = json.permanentFailed ?? 0;
        if (retryFailed > 0 && permanentCounts[idx] >= retryFailed) permanent[idx] = true;
        photoDroppedCounts[idx] = json.photoDropped ?? 0;
        // 재시도 응답의 written/already는 이 배치의 최종 상태를 온전히 담는다(서버가
        // 원장을 기준으로 이미 등록된 건을 already로 돌려준다). 이전 시도의 부분 성공을
        // written에 더하면 이중 계산되므로, 응답값으로 교체한다.
        results[idx] = { written: json.written ?? 0, failed: json.failed ?? 0, already: json.already ?? 0 };
        if (json.freeRemaining !== undefined && json.freeRemaining !== null) {
          freeRemaining = json.freeRemaining;
          if (!json.paid) usedNow = (quota?.limit ?? 20) - freeRemaining;
        }
        return true;
      } catch {
        return false;
      }
    };

    const productName = products.find((p) => p.no === productNo)?.name ?? `상품 ${productNo}`;
    // 이전 실행에서 끝난 구간 — 이번 실행의 results엔 안 잡히므로 "미등록" 계산에 더한다.
    const resumedCount = Math.min(startResumeIdx * IMPORT_BATCH, reviews.length);
    const totalPhotoDropped = photoDroppedCounts.reduce((s, n) => s + n, 0);
    const persistSummary = (over: Partial<LastRun> = {}) => {
      const resumed = resumedCount;
      const written = over.written ?? results.reduce((s, r) => s + (r?.written ?? 0), 0);
      const already = over.already ?? results.reduce((s, r) => s + (r?.already ?? 0), 0);
      const failed = over.failed ?? results.reduce((s, r) => s + (r?.failed ?? 0), 0);
      saveLastRun({
        productNo,
        productName,
        fileName: file?.name ?? '',
        parsed: reviews.length,
        resumed,
        written,
        already,
        failed,
        notRegistered: Math.max(0, reviews.length - resumed - written - already),
        photoDropped: over.photoDropped ?? totalPhotoDropped,
      });
    };

    try {
      for (let idx = resumeIdx; idx < batchCount; idx++) {
        if (quotaExhausted || stopRef.current) break;
        const r = await sendOne(idx);
        if (r.kind === 'quota') {
          // 무료 한도 소진 — 여기까지 기록된 것을 남기고 중단한다.
          quotaExhausted = true;
          usedNow = r.json.used ?? usedNow;
          saveProgress(rkey, resumeIdx * IMPORT_BATCH);
          setResult({ quotaExceeded: true, used: usedNow });
          setQuota((q) => (q ? { ...q, used: q.limit } : q));
          break;
        }
        if (r.kind === 'err') {
          // 배치 하나가 실패해도 전체를 멈추지 않는다 — 실패로 기록하고 아래 자동
          // 이어하기 루프에서 물러나 다시 시도한다.
          bumpAttempted(idx);
          results[idx] = { written: 0, failed: sliceLen(idx), already: 0 };
          continue;
        }
        onBatchDone(idx, r.json);
      }

      if (!quotaExhausted && !stopRef.current) {
        // 자동 이어하기 루프 — 성공 배치는 해시로 걸러져(already) 안전하므로, 한 번의
        // 「옮기기」로 파일 전체가 끝날 때까지 반복 진행한다. 실패가 이어지면
        // 30→60→120초로 물러나 기다렸다가 다시 시도하고, 사용자가 「정지」를 누르거나
        // 무료 한도가 소진된 경우에만 멈춘다.
        let backoffStep = 0;
        while (!quotaExhausted && !stopRef.current) {
          const failedIdxs: number[] = [];
          for (let idx = 0; idx < batchCount; idx++) {
            // 영구 실패(400·422·행 단위 거부) 배치는 다시 시도해도 실패한다 — 무한 재시도를 막는다.
            if (permanent[idx]) continue;
            const r = results[idx];
            if (!r || r.failed > 0) failedIdxs.push(idx);
          }
          if (!failedIdxs.length) break;
          if (backoffStep > 0) {
            // 진행 없이 실패가 이어진 라운드 — 물러난 뒤 다시 시도한다.
            const waitMs = BACKOFF_STEPS_MS[Math.min(backoffStep - 1, BACKOFF_STEPS_MS.length - 1)];
            await backoffWait(
              waitMs,
              () => stopRef.current || quotaExhausted,
              (sec) => setImportProgress((p) => (p ? { ...p, retrying: sec } : p)),
            );
            if (stopRef.current || quotaExhausted) break;
          }
          let anyProgress = false;
          for (const idx of failedIdxs) {
            if (quotaExhausted || stopRef.current) break;
            const ok = await sendRetry(idx);
            if (ok) {
              const rr = results[idx];
              if (rr && rr.failed === 0) {
                anyProgress = true;
                done[idx] = true;
                while (resumeIdx < batchCount && done[resumeIdx]) resumeIdx++;
                saveProgressAndState();
              }
            }
          }
          backoffStep = anyProgress ? 0 : backoffStep + 1;
          if (!stopRef.current && !quotaExhausted && failedIdxs.length) {
            await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
          }
        }
      }

      const totalWritten = results.reduce((s, r) => s + (r?.written ?? 0), 0);
      const totalFailed = results.reduce((s, r) => s + (r?.failed ?? 0), 0);
      const totalAlready = results.reduce((s, r) => s + (r?.already ?? 0), 0);
      const totalPermanentFailed = permanentCounts.reduce((s, n) => s + n, 0);

      if (quotaExhausted) {
        persistSummary();
        setResult({ quotaExceeded: true, used: usedNow });
        setQuota((q) => (q ? { ...q, used: q.limit } : q));
        loadImports(1, filterProduct, filterPhotoDropped);
      } else if (totalFailed > 0 || resumeIdx < batchCount) {
        // 「정지」를 누르거나 영구 실패로 남은 건이 있다 — 여기까지 기록되고 다음
        // 「옮기기」가 이어서 진행한다(중복은 서버가 걸러낸다).
        persistSummary();
        saveProgress(rkey, resumeIdx * IMPORT_BATCH);
        loadImports(1, filterProduct, filterPhotoDropped);
        setResult({
          stage: 'stopped',
          parsed: reviews.length,
          written: totalWritten,
          failed: totalFailed,
          permanentFailed: totalPermanentFailed,
          already: totalAlready,
          photoDropped: totalPhotoDropped,
          skipped: Math.max(0, reviews.length - resumedCount - totalWritten - totalAlready),
          freeRemaining,
          paid: quota?.paid,
        });
        if (!quota?.paid && typeof freeRemaining === 'number') {
          const used = (quota?.limit ?? 20) - freeRemaining;
          setQuota((q) => (q ? { ...q, used } : q));
        }
      } else {
        // 전부 옮겨졌다 — 이어올 지점을 지운다.
        persistSummary();
        try {
          localStorage.removeItem(rkey);
        } catch {
          // 저장소 접근이 거부되면 남은 진행 지점이 다음 번에 재개로 오인될 수 있지만,
          // offset >= reviews.length면 readResume이 0으로 되돌리므로 실제 영향은 없다.
        }
        setResult({
          parsed: reviews.length,
          written: totalWritten,
          failed: 0,
          permanentFailed: totalPermanentFailed,
          already: totalAlready,
          photoDropped: totalPhotoDropped,
          skipped: Math.max(0, reviews.length - resumedCount - totalWritten - totalAlready),
          freeRemaining,
          paid: quota?.paid,
        });
        if (!quota?.paid && typeof freeRemaining === 'number') {
          const used = (quota?.limit ?? 20) - freeRemaining;
          setQuota((q) => (q ? { ...q, used } : q));
        }
        setFilterProduct('');
        loadImports(1, '');
      }
    } catch (e) {
      // 중간 실패 — 진행 지점을 남겨 두어 다음 「옮기기」가 이어서 진행하게 한다.
      persistSummary();
      saveProgress(rkey, resumeIdx * IMPORT_BATCH);
      setResult({
        stage: 'write',
        parsed: reviews.length,
        written: results.reduce((s, r) => s + (r?.written ?? 0), 0),
        failed: results.reduce((s, r) => s + (r?.failed ?? 0), 0),
        permanentFailed: permanentCounts.reduce((s, n) => s + n, 0),
        already: results.reduce((s, r) => s + (r?.already ?? 0), 0),
        photoDropped: photoDroppedCounts.reduce((s, n) => s + n, 0),
        skipped: reviews.length - results.reduce((s, r) => s + (r?.written ?? 0) + (r?.already ?? 0), 0),
        error: (e as Error).message,
      });
    } finally {
      setBusy(false);
      setImportProgress(null);
      // 사진 누락 누계 갱신 — 안내 배너·필터용.
      photoDroppedCount(filterProduct).then(setPhotoDroppedTotal);
      try {
        await wakeLockRef.current?.release();
      } catch {}
      wakeLockRef.current = null;
    }
  }

  function saveProgress(key: string, offset: number) {
    try {
      localStorage.setItem(key, String(offset));
    } catch {
      // 저장소 접근이 거부되면(iframe·비공개 모드) 재개 지점을 못 남기지만 진행은 계속한다.
    }
  }

  /** 지난 이관 요약을 브라우저에 남긴다(서버 저장 없음). */
  function saveLastRun(summary: Omit<LastRun, 'at'>) {
    const rec: LastRun = { ...summary, at: Date.now() };
    try {
      localStorage.setItem(lastRunKey(mallName), JSON.stringify(rec));
    } catch {}
    setLastRun(rec);
  }

  async function deleteImports(snos: number[]) {
    if (!snos.length || delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    setDeleteProgress({ deleted: 0, total: snos.length, failed: 0 });
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      for (let i = 0; i < snos.length; i += DELETE_CHUNK) {
        const chunk = snos.slice(i, i + DELETE_CHUNK);
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(DELETE_FETCH_TIMEOUT_MS),
          body: JSON.stringify({ article_snos: chunk }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        setDeleteProgress({ deleted: totalDeleted, total: snos.length, failed: totalFailed });
      }
      if (totalDeleted) {
        // 마지막 페이지의 글을 다 지웠다면 page가 새 마지막 페이지를 넘어 "3/2페이지"처럼
        // 빈 목록이 보이지 않게, 삭제 후 총건수로 계산한 마지막 페이지로 조정한다.
        const remaining = Math.max(0, total - totalDeleted);
        const lastPage = Math.max(1, Math.ceil(remaining / PAGE_SIZE));
        await loadImports(Math.min(page, lastPage), filterProduct, filterPhotoDropped);
        setSelected(new Set());
      }
      // 목록 재조회(loadImports)가 메시지 상태를 먼저 지우므로, 완료 메시지는 그 뒤에 남긴다.
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
      setDeleteProgress(null);
    }
  }

  /** 현재 필터의 모든 옮긴 리뷰를 고도몰에서 지우고 원장도 정리한다. 서버가 hasMore로 순회한다. */
  async function deleteAllFiltered() {
    if (
      !window.confirm(
        filterPhotoDropped
          ? '사진 빠진 리뷰를 모두 삭제할까요? 쇼핑몰 게시판에서도 함께 삭제됩니다. 저장 공간을 늘린 뒤 같은 엑셀을 다시 올리면 사진이 포함되어 등록됩니다.'
          : '현재 필터(전체 상품 포함)의 모든 리뷰를 삭제할까요? 쇼핑몰 게시판에서도 함께 삭제됩니다.',
      )
    )
      return;
    if (delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    // 전체 삭제는 목록 총 건수를 기준으로 진행률을 보여준다.
    const totalTarget = Math.max(1, total);
    setDeleteProgress({ deleted: 0, total: totalTarget, failed: 0 });
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      let hasMore = true;
      while (hasMore) {
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(DELETE_FETCH_TIMEOUT_MS),
          body: JSON.stringify({
            all: true,
            product_no: filterProduct || undefined,
            photo_dropped: filterPhotoDropped,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        totalDeleted += (json.deleted ?? []).length;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        hasMore = !!json.hasMore;
        setDeleteProgress({ deleted: totalDeleted, total: totalTarget, failed: totalFailed });
      }
      if (totalDeleted) {
        await loadImports(1, filterProduct, filterPhotoDropped);
        setSelected(new Set());
      }
      // 목록 재조회(loadImports)가 메시지 상태를 먼저 지우므로, 완료 메시지는 그 뒤에 남긴다.
      setImportedMsg(
        totalFailed
          ? `삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `삭제 완료 ${totalDeleted}건`,
      );
    } catch (e) {
      setImportedError((e as Error).message);
    } finally {
      setDelBusy(false);
      setDeleteProgress(null);
    }
  }

  /** 사진 없이 등록된 리뷰만 골라 모두 삭제한다. 재이관 가드·「사진 빠진 리뷰만」 삭제에 쓴다. */
  async function deletePhotoDroppedForProduct(productNo: number | '', totalHint: number): Promise<boolean> {
    if (delBusy) return false;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    setDeleteProgress({ deleted: 0, total: Math.max(1, totalHint), failed: 0 });
    let totalDeleted = 0;
    let totalFailed = 0;
    let firstErr = '';
    try {
      let hasMore = true;
      while (hasMore) {
        const res = await fetch('/api/imports', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(DELETE_FETCH_TIMEOUT_MS),
          body: JSON.stringify({
            all: true,
            product_no: productNo || undefined,
            photo_dropped: true,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? '삭제하지 못했습니다.');
        const deleted = (json.deleted ?? []).length;
        totalDeleted += deleted;
        totalFailed += (json.failed ?? []).length;
        if (!firstErr && json.failed?.length) firstErr = json.failed[0].error ?? '';
        hasMore = !!json.hasMore && deleted > 0;
        setDeleteProgress({ deleted: totalDeleted, total: Math.max(1, totalHint), failed: totalFailed });
      }
      setImportedMsg(
        totalFailed
          ? `사진 빠진 리뷰 삭제 완료 ${totalDeleted}건 · 실패 ${totalFailed}건 (${firstErr})`
          : `사진 빠진 리뷰 삭제 완료 ${totalDeleted}건`,
      );
      return true;
    } catch (e) {
      setImportedError((e as Error).message);
      return false;
    } finally {
      setDelBusy(false);
      setDeleteProgress(null);
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
        {busy && !parsing && importProgress && (
          <button
            onClick={() => {
              stopRef.current = true;
            }}
            className="rounded border px-4 py-2 text-sm text-red-600 disabled:opacity-40 dark:border-neutral-600 dark:text-red-400"
          >
            정지
          </button>
        )}
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
          {importProgress.retrying != null && (
            <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              일시적으로 등록이 막혀 {importProgress.retrying}초 뒤 자동으로 이어서 시도합니다.
            </p>
          )}
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
            한 번 누르면 끝날 때까지 자동으로 이어서 옮깁니다. 도중에 등록이 막혀도 물러났다
            자동으로 다시 시도하고, 걸릴 만큼 길면 「정지」를 눌러 주세요. 이미 옮긴 리뷰를 다시
            보내도 중복 등록되지 않습니다.
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
          ) : result.stage === 'stopped' ? (
            <>
              <p className="font-medium text-amber-700 dark:text-amber-400">
                정지했습니다. 여기까지 {result.written}건은 옮겨져 목록에 남아 있습니다.
              </p>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                남은 리뷰는 「옮기기」를 누르면 중복 없이 이어서 등록됩니다.
              </p>
              {(result.permanentFailed ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  (고도몰이 거부한 {result.permanentFailed}건은 다시 시도해도 실패할 수 있어요. 상품·작성자
                  정보를 확인해 주세요.)
                </p>
              ) : null}
            </>
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
                  여기까지 {result.written}건은 옮겨져 목록에 남아 있습니다.
                  {(result.already ?? 0) > 0 ? ` (이미 옮겨진 ${result.already}건 제외)` : ''}
                  {' '}
                  「옮기기」를 다시 누르면 이어서 진행됩니다.
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
                    {(s.images ?? []).length > 0 && (
                      <span className="mt-1 block">
                        {(s.images ?? []).map((u, j) => (
                          <a key={j} href={u} target="_blank" rel="noreferrer" className="mr-2 underline">
                            첨부 이미지{j + 1}
                          </a>
                        ))}
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
              {(result.skipped ?? 0) > 0 ? (
                <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                  파일의 {result.parsed}건 중 아직 {result.skipped}건이 등록되지 않았어요.{' '}
                  「옮기기」를 다시 누르면 중복 없이 이어서 등록됩니다.
                </p>
              ) : null}
              {(result.permanentFailed ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  (고도몰이 거부한 {result.permanentFailed}건은 다시 눌러도 실패할 수 있어요)
                </p>
              ) : null}
              {(result.already ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  (이미 옮겨진 {result.already}건은 중복이라 건너뛰었습니다)
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
            onClick={() => loadImports(page, filterProduct, filterPhotoDropped)}
            className="rounded border px-3 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            새로고침
          </button>
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          삭제하면 쇼핑몰 게시판에서도 함께 지워집니다. 목록은 {PAGE_SIZE}건씩 보여드립니다.
          새로 옮긴 리뷰는 바로 여기 나타납니다.
        </p>

        <PhotoDroppedNotice count={photoDroppedTotal} />

        {lastRun && (
          <div className="mt-3 rounded border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-800">
            <p className="font-medium text-neutral-700 dark:text-neutral-200">최근 이관 요약</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              {lastRun.fileName ? `'${lastRun.fileName}' ` : ''}전체 {lastRun.parsed}건 중{' '}
              <span className="font-semibold text-neutral-800 dark:text-neutral-100">
                {(lastRun.resumed ?? 0) + lastRun.written + lastRun.already}건 등록
              </span>
              {lastRun.notRegistered > 0 ? (
                <>
                  {' · '}
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    {lastRun.notRegistered}건 미등록
                  </span>
                </>
              ) : null}
              {(lastRun.photoDropped ?? 0) > 0 ? (
                <>
                  {' · '}
                  <span className="font-semibold text-amber-700 dark:text-amber-400">
                    {lastRun.photoDropped}건 사진 빠짐
                  </span>
                </>
              ) : null}
              {' '}({new Date(lastRun.at).toLocaleString('ko-KR')})
            </p>
            {lastRun.notRegistered > 0 ? (
              <p className="mt-1 text-neutral-500 dark:text-neutral-400">
                미등록 리뷰는 아직 게시판에 올라가지 않은 건입니다. 같은 엑셀로 「옮기기」를 다시 누르면
                중복 없이 이어서 등록됩니다.
                {lastRun.failed > 0
                  ? ' (일부는 고도몰이 거부한 건이라, 「옮기기」 결과의 안내를 함께 확인해 주세요.)'
                  : ''}
              </p>
            ) : null}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded border p-1.5 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            value={filterProduct}
            onChange={(e) => {
              const v = Number(e.target.value) || '';
              setFilterProduct(v);
              loadImports(1, v, filterPhotoDropped);
            }}
          >
            <option value="">전체 상품</option>
            {products.map((p) => (
              <option key={p.no} value={p.no}>
                [{p.no}] {p.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={filterPhotoDropped}
              onChange={(e) => {
                const v = e.target.checked;
                setFilterPhotoDropped(v);
                loadImports(1, filterProduct, v);
              }}
            />
            사진 빠진 리뷰만{photoDroppedTotal > 0 ? ` (${photoDroppedTotal})` : ''}
          </label>
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
            {filterPhotoDropped ? `사진 빠진 리뷰 삭제 (${total}건)` : `전체 삭제 (${total}건)`}
          </button>
          {delBusy && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              삭제하는 중…
            </span>
          )}
        </div>

        {deleteProgress && (
          <div className="mt-3 rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex justify-between text-neutral-600 dark:text-neutral-300">
              <span>
                삭제하는 중 {Math.min(deleteProgress.deleted, deleteProgress.total)} /{' '}
                {deleteProgress.total}건
                {deleteProgress.failed > 0 ? ` · 실패 ${deleteProgress.failed}건` : ''}
              </span>
              <span className="font-semibold">
                {deleteProgress.total > 0
                  ? `${Math.round(
                      Math.min(100, (deleteProgress.deleted / deleteProgress.total) * 100),
                    )}%`
                  : '0%'}
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-700">
              <div
                className="h-1.5 rounded-full bg-black dark:bg-white transition-all"
                style={{
                  width: `${
                    deleteProgress.total > 0
                      ? Math.min(
                          100,
                          Math.round((deleteProgress.deleted / deleteProgress.total) * 100),
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}

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
                        {r.photo_dropped ? (
                          <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                            사진 빠짐
                          </span>
                        ) : null}
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
                  onClick={() => loadImports(page - 1, filterProduct, filterPhotoDropped)}
                  disabled={page <= 1}
                  className="rounded border px-2 py-0.5 disabled:opacity-40 dark:border-neutral-600"
                >
                  이전
                </button>
                <button
                  onClick={() => loadImports(page + 1, filterProduct, filterPhotoDropped)}
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