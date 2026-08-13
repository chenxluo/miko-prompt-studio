import { AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import { useI18n } from '../../i18n';
import { CodeBlock } from '../shared/CodeBlock';

interface ParsedOutputViewProps {
  parsed: unknown;
  parseStatus: string | undefined;
  fallbackText: string | undefined;
}

export function ParsedOutputView({
  parsed,
  parseStatus,
  fallbackText,
}: ParsedOutputViewProps) {
  const { t } = useI18n();

  if (parseStatus === 'not_parsed' || parseStatus === 'parse_failed') {
    const text = typeof parsed === 'string' ? parsed : fallbackText;
    if (text) {
      return (
        <div className="markdown-body overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 text-sm text-ink">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
        {t('result.notParsed')}
      </div>
    );
  }

  if (parseStatus === 'parsed' && parsed !== undefined) {
    return (
      <CodeBlock value={parsed} />
    );
  }

  if (parseStatus === 'partially_parsed') {
    return (
      <div className="rounded-md bg-cost/10 px-3 py-3 text-sm text-cost">
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <AlertTriangle size={14} />
          {t('result.partiallyParsed')}
        </div>
        {parsed !== undefined && (
          <CodeBlock value={parsed} className="mt-2" />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-ink-dim">
      {t('result.notParsed')}
    </div>
  );
}

