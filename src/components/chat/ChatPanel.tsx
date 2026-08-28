'use client';

import { useEffect, useRef, useState } from 'react';
import { QUICK_QUESTIONS } from '@/lib/chat/knowledge';

type Msg = { role: 'user' | 'assistant'; content: string; streaming?: boolean };

const GREETING: Msg = {
  role: 'assistant',
  content: '안녕하세요! 리뷰이사 고객지원입니다 👋 설치, 이용 방법, 오류 등 궁금한 점을 물어보세요.',
};

/** OpenRouter(OpenAI 호환) SSE(data: {"text": ...})를 읽어 onText로 흘려보낸다. */
async function readAssistantStream(res: Response, onText: (t: string) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (typeof json.text === 'string') onText(json.text);
      } catch {
        // 파싱 실패 줄은 무시
      }
    }
  }
}

export default function ChatPanel({
  title,
  variant,
  onClose,
}: {
  title: string;
  variant: 'widget' | 'inline';
  onClose?: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setInput('');
    setFatal(null);
    const history: Msg[] = [...messages, { role: 'user', content }];
    setMessages([...history, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // streaming 중인 빈 assistant 메시지는 제외하고 보낸다
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        let msg = '잠시 후 다시 시도해 주세요.';
        if (res.status === 503) msg = '챗봇이 아직 준비되지 않았어요. 아래 이메일로 문의해 주세요.';
        else if (res.status === 429) msg = '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.';
        setFatal(msg);
        setMessages((prev) => prev.slice(0, -1).concat({ role: 'assistant', content: msg }));
        return;
      }

      await readAssistantStream(res, (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { role: 'assistant', content: last.content + delta, streaming: true };
          }
          return next;
        });
      });
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.streaming) next[next.length - 1] = { ...last, streaming: false };
        return next;
      });
    } catch {
      setMessages((prev) => prev.slice(0, -1).concat({
        role: 'assistant',
        content: '연결에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="고객지원 챗봇"
      className={`flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${
        variant === 'widget' ? 'h-[28rem]' : 'h-[30rem]'
      }`}
    >
      {/* 헤더 */}
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-700">
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden />
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            AI
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="닫기"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </header>

      {/* 메시지 영역 */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-6 ${
                m.role === 'user'
                  ? 'rounded-br-md bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                  : 'rounded-bl-md bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100'
              }`}
            >
              {m.content}
              {m.streaming && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
            </div>
          </div>
        ))}
        {fatal && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            사람 상담이 필요하면{' '}
            <a className="underline" href="mailto:kwan765@naver.com">
              kwan765@naver.com
            </a>
            으로 연락 주세요.
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* 추천 질문 + 입력 */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-700">
        {messages.length <= 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder="궁금한 점을 입력하세요"
            aria-label="메시지 입력"
            className="max-h-28 flex-1 resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            aria-label="전송"
            className="rounded-xl bg-neutral-900 px-3.5 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.4 20.4 20.85 12 3.4 3.6 3.39 10.3 15.1 12 3.39 13.7Z" />
            </svg>
          </button>
        </div>
        <p className="mt-2 text-[10px] text-neutral-400 dark:text-neutral-500">
          AI 답변은 참고용입니다. 정확한 처리는 이메일{' '}
          <a className="underline" href="mailto:kwan765@naver.com">
            kwan765@naver.com
          </a>{' '}
          또는 <a className="underline" href="/support">문의하기</a>로.
        </p>
      </div>
    </section>
  );
}