import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { parseReviewFile, toDateTime } from '@/lib/reviewImport';
import { identifyReviews, MAX_BATCH } from '@/lib/transferInput';
import { POST as writeBatch } from './batch/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!await sessionMall()) return NextResponse.json({ error: 'no session' }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return NextResponse.json({ error: 'file required' }, { status: 400 });
    const parsed = parseReviewFile(await file.arrayBuffer());
    const reviews = identifyReviews(parsed.reviews);
    if (!reviews.length) return NextResponse.json({ error: 'no reviews parsed' }, { status: 400 });
    if (form.get('dry_run') === '1') return NextResponse.json({ dryRun: true, count: reviews.length,
      sample: reviews.slice(0, 3).map(r => ({ ...r, createdAt: toDateTime(r.createdAt) })) });
    if (reviews.length > MAX_BATCH) return NextResponse.json({ error: '대량 이관은 앱 화면에서 진행해 주세요.' }, { status: 400 });
    const headers = new Headers(req.headers); headers.set('Content-Type', 'application/json'); headers.delete('content-length');
    return writeBatch(new NextRequest(req.url, { method: 'POST', headers, body: JSON.stringify({
      product_no: form.get('product_no'), source: form.get('source') ?? 'coupang', reviews,
    }) }));
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
