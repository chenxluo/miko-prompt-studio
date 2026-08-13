import { useMemo, useState } from 'react';
import { WrapText } from 'lucide-react';

import { useI18n } from '../../i18n';

interface CodeBlockProps {
  /** Strings render verbatim; any other value is pretty-printed as JSON. */
  value: unknown;
  /** CSS max-height (e.g. '16rem') — when set, the body scrolls vertically. */
  maxHeight?: string;
  /** Initial wrap state. Defaults to true (wrap + line numbers). */
  defaultWrap?: boolean;
  /** Extra classes for the outer (bordered) box, e.g. spacing. */
  className?: string;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Read-only, line-numbered code view with optional soft wrap. Line numbers
 * label logical lines (split on \n), so a wrapped logical line keeps its
 * number pinned to its first visual row — wrapping stays scannable.
 */
export function CodeBlock({ value, maxHeight, defaultWrap = true, className }: CodeBlockProps) {
  const { t } = useI18n();
  const [wrap, setWrap] = useState(defaultWrap);
  const lines = useMemo(() => toText(value).split('\n'), [value]);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  return (
    <div className={['group relative rounded-md border border-surface-800 bg-surface-950 font-mono text-xs text-ink', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        onClick={() => setWrap((w) => !w)}
        title={wrap ? t('code.unwrap') : t('code.wrap')}
        className="absolute right-1.5 top-1.5 z-10 rounded p-1 text-ink-dim opacity-60 transition-opacity hover:bg-surface-800 hover:text-ink hover:opacity-100"
      >
        <WrapText size={13} className={wrap ? 'text-accent' : ''} />
      </button>
      <div
        className="overflow-auto p-3"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {lines.map((line, i) => (
          <div key={i} className="flex items-start leading-relaxed">
            <span
              className="sticky left-0 mr-3 select-none bg-surface-950 pr-1 text-right text-ink-dim"
              style={{ minWidth: gutterWidth }}
            >
              {i + 1}
            </span>
            <span className={wrap ? 'flex-1 min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre'}>
              {line === '' ? '\u00a0' : line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
