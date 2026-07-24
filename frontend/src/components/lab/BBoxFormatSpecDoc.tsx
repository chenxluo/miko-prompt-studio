import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, FileText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import type { BBoxFormat } from '../../types';
import { buildFormatSpecDoc } from '../../utils/bboxDoc';
import { copyText } from '../../utils/clipboard';

type CoordOrder = NonNullable<BBoxFormat['order']>;
type CoordSpace = NonNullable<BBoxFormat['space']>;

interface BBoxFormatSpecDocProps {
  pattern: string;
  coordGroups: number[];
  labelGroup: number | null;
  order: CoordOrder;
  space: CoordSpace;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Live preview of the prompt fragment that describes the current custom
 * bbox format to the model. Regenerates on every config change; one click
 * copies it so the user can paste it into their prompt.
 */
export function BBoxFormatSpecDoc({
  pattern,
  coordGroups,
  labelGroup,
  order,
  space,
}: BBoxFormatSpecDocProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timerRef = useRef<number | undefined>(undefined);

  const doc = useMemo(
    () => buildFormatSpecDoc({ pattern, coordGroups, labelGroup, order, space }, t),
    [pattern, coordGroups, labelGroup, order, space, t],
  );

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  async function handleCopy() {
    try {
      await copyText(doc);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('prompt.bboxParser.docs.toggle')}
          title={t('prompt.bboxParser.docs.toggle')}
          className="flex items-center gap-1.5 text-[10px] text-ink-dim transition-colors hover:text-ink-muted"
        >
          <FileText size={11} />
          {t('prompt.bboxParser.docs.title')}
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className={[
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors',
            copyState === 'copied'
              ? 'border-emerald-500/40 text-emerald-400'
              : 'border-surface-700 text-ink-muted hover:border-surface-600 hover:text-ink',
          ].join(' ')}
        >
          {copyState === 'copied' ? <Check size={10} /> : <Copy size={10} />}
          {copyState === 'copied'
            ? t('prompt.bboxParser.docs.copied')
            : t('prompt.bboxParser.docs.copy')}
        </button>
      </div>

      {open && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-surface-800 bg-surface-950 p-2.5 font-mono text-[11px] leading-relaxed text-ink">
          {doc}
        </pre>
      )}

      {copyState === 'failed' && (
        <div className="flex items-center gap-1 text-[10px] text-amber-400">
          <AlertTriangle size={10} />
          {t('prompt.bboxParser.docs.copyFailed')}
        </div>
      )}
    </div>
  );
}
