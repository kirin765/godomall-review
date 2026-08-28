import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt, type ChatRole } from '@/lib/chat/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type IncomingMessage = { role?: string; content?: string };

const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MAX_HISTORY = 12; // 마지막 N개 턴만 모델로 보낸다 (비용·프롬프트 안전)
const MAX_CONTENT = 2000; // 한 메시지 최대 글자 수
const MAX_MESSAGES = 24; // 요청 본문 최대 메시지 수

/** 간단한 IP 기반 1분 단위 제한. 서버리스에선 best-effort다. */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 30;
}

/** OpenRouter SSE를 {"text": ...} SSE로 재인코딩하는 스트림. */
function textTransform(upstream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  let metaSent = false;

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? ''; // 마지막 조각은 다음 청크에서 이어 붙인다
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue; // keep-alive(: OPENROUTER PROCESSING) 무시
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            // 첫 이벤트에 사용된 모델명을 함께 실어 검증·디버깅에 쓴다 (클라이언트는 text만 읽는다)
            if (!metaSent && typeof json?.model === 'string' && json.model) {
              metaSent = true;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: '', model: json.model })}\n\n`));
            }
            const text = json?.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
            }
          } catch {
            // 파싱 불가한 줄은 무시
          }
        }
      },
    }),
  );
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { messages?: IncomingMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  if (!raw.length) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }
  if (raw.length > MAX_MESSAGES) raw.length = MAX_MESSAGES;

  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  // 클라이언트가 보낸 히스토리 중 user/assistant만, 잘린 메시지는 버린다.
  const history: { role: ChatRole; content: string }[] = [];
  for (const m of raw) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (role && content && content.length <= MAX_CONTENT) history.push({ role, content });
  }
  const messages: { role: ChatRole; content: string }[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...history.slice(-MAX_HISTORY),
  ];

  try {
    const origin = req.nextUrl.origin;
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      // 모델 응답이 50초 안에 시작되지 않으면 중단 (Vercel maxDuration=60과 맞물림)
      signal: AbortSignal.timeout(50_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // OpenRouter 랭킹·통계용 — 헤더 값은 ASCII만 가능하다 (호스트명 사용)
        'HTTP-Referer': origin,
        'X-Title': origin.replace(/^https?:\/\//, ''),
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        temperature: 0.6,
        max_tokens: 600,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      console.error('[chat] openrouter error', upstream.status, detail.slice(0, 200));
      return NextResponse.json(
        { error: 'upstream_error' },
        { status: upstream.status === 429 ? 429 : 502 },
      );
    }

    return new Response(textTransform(upstream.body), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  } catch (e) {
    const aborted = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    if (aborted) return new Response(null, { status: 499 });
    console.error('[chat] upstream fetch failed', e);
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 });
  }
}