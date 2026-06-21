import { Globe } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { useI18n, type Locale } from '../i18n';

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const options: { value: Locale; label: string }[] = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ];

  const currentLabel = options.find((o) => o.value === locale)?.label ?? '中文';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-ink-dim transition-colors hover:bg-surface-800 hover:text-ink"
        title={t('nav.settings')}
      >
        <Globe size={14} />
        <span>{currentLabel}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-28 rounded-md border border-surface-700 bg-surface-900 py-1 shadow-panel">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setLocale(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors hover:bg-surface-800 ${
                locale === opt.value ? 'text-accent' : 'text-ink-muted'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
