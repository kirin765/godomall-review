'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'godo-review-theme';

/** <html class="dark"> 토글. 시스템 기본값을 따라가되, 사용자가 고르면 localStorage에 저장한다. */
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // iframe·비공개 모드 등 저장소 접근이 거부되면 시스템 기본값만 따른다.
    }
    const initial = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', initial);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(initial);
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // 저장소 접근이 거부되면 이번 세션 동안만 유지한다.
    }
  }

  // 초기 렌더링(깜빡임 방지) 전에는 아무것도 안 그린다.
  if (!mounted) return <span className="inline-block h-5 w-5" aria-hidden />;

  return (
    <button
      onClick={toggle}
      aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}
      title={dark ? '라이트 모드' : '다크 모드'}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-300 bg-white text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-5.4-5.4c0-1.81.89-3.42 2.26-4.4A9 9 0 0 0 12 3Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-4a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 14a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1ZM4 11a1 1 0 0 1 0 2H2a1 1 0 1 1 0-2h2Zm18 0a1 1 0 0 1 0 2h-2a1 1 0 1 1 0-2h2ZM5.64 5.64a1 1 0 0 1 1.42 0l1.41 1.41a1 1 0 1 1-1.41 1.42L5.64 7.06a1 1 0 0 1 0-1.42Zm10.9 10.9a1 1 0 0 1 1.42 0l1.41 1.41a1 1 0 0 1-1.42 1.42l-1.41-1.41a1 1 0 0 1 0-1.42Zm1.41-10.9a1 1 0 0 1 0 1.42l-1.41 1.41a1 1 0 1 1-1.42-1.41l1.41-1.41a1 1 0 0 1 1.42 0ZM7.05 16.95a1 1 0 0 1 1.42 0l1.41 1.41a1 1 0 1 1-1.42 1.42l-1.41-1.41a1 1 0 0 1 0-1.42Z" />
        </svg>
      )}
    </button>
  );
}