import { Brain, ChevronDown, Sparkles } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { useI18n } from '../../i18n';

interface ReasoningBlockProps {
  reasoningText: string | undefined;
}

export function ReasoningBlock({ reasoningText }: ReasoningBlockProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);

  if (!reasoningText) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center justify-between rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-left transition-colors hover:border-accent/30 hover:bg-accent/10"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-accent">
          <Sparkles size={12} />
          <Brain size={14} />
          <span>{t('result.reasoning')}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span>{isExpanded ? t('result.hideReasoning') : t('result.showReasoning')}</span>
          <ChevronDown
            size={14}
            className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>
      {isExpanded && (
        <div className="markdown-body overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 text-sm text-ink">
          <ReactMarkdown>{reasoningText}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
