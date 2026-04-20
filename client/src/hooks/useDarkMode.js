import { useEffect, useState } from 'react';

const KEY = 'biztrack_theme';

export default function useDarkMode() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem(KEY);
    if (saved) return saved === 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem(KEY, dark ? 'dark' : 'light');
  }, [dark]);

  return [dark, () => setDark((d) => !d), setDark];
}
