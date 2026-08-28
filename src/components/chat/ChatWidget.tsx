'use client';

import { useState } from 'react';
import ChatPanel from './ChatPanel';

/** 모든 페이지 오른쪽 아래에 뜨는 고객지원 챗봇 버튼. */
export default function ChatWidget() {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-[min(92vw,22rem)]">
          <ChatPanel title="리뷰이사 고객지원" variant="widget" onClose={() => setOpen(false)} />
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '챗봇 닫기' : '고객지원 챗봇 열기'}
        aria-expanded={open}
        className="flex items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg transition hover:scale-105 dark:bg-white dark:text-neutral-900"
        style={{ width: 52, height: 52 }}
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path
              d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}