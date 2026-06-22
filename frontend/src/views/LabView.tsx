import { FlaskConical, History, X } from 'lucide-react';
import { useState } from 'react';

import { ImagePanel } from '../components/lab/ImagePanel';
import { ModelBar } from '../components/lab/ModelBar';
import { PromptPanel } from '../components/lab/PromptPanel';
import { ResultPanel } from '../components/lab/ResultPanel';
import { RunHistory } from '../components/lab/RunHistory';
import { useI18n } from '../i18n';
import { type LabViewMode, useLabStore } from '../store/labStore';

const MODES: { id: LabViewMode; labelKey: string }[] = [
  { id: 'edit', labelKey: 'lab.viewMode.edit' },
  { id: 'prompt-result', labelKey: 'lab.viewMode.promptResult' },
  { id: 'image-result', labelKey: 'lab.viewMode.imageResult' },
];

export function LabView() {
  const { t } = useI18n();
  const viewMode = useLabStore((state) => state.viewMode);
  const setViewMode = useLabStore((state) => state.setViewMode);

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const gridClass =
    viewMode === 'edit'
      ? 'grid-cols-1 lg:grid-cols-2'
      : 'grid-cols-1 lg:grid-cols-[1fr_1.5fr]';

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden bg-surface-950 p-3">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10 text-accent">
            <FlaskConical size={16} strokeWidth={2} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">{t('lab.title')}</h2>
            <p className="text-[10px] leading-tight text-ink-dim">{t('lab.description')}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex items-center rounded-md border border-surface-700 bg-surface-900 p-0.5"
            role="tablist"
            aria-label={t('lab.title')}
          >
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={viewMode === mode.id}
                onClick={() => setViewMode(mode.id)}
                className={[
                  'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  viewMode === mode.id
                    ? 'bg-surface-800 text-accent'
                    : 'text-ink-muted hover:bg-surface-800/50 hover:text-ink',
                ].join(' ')}
              >
                {t(mode.labelKey)}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setIsHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-900 px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-surface-600 hover:bg-surface-800 hover:text-ink"
            aria-expanded={isHistoryOpen}
            aria-label={t('history.title')}
          >
            <History size={14} />
            <span className="hidden sm:inline">{t('history.title')}</span>
          </button>
        </div>
      </header>

      <ModelBar />

      <div
        className={`grid min-h-0 flex-1 gap-4 overflow-hidden ${gridClass}`}
      >
        {viewMode === 'edit' && (
          <>
            <ImagePanel />
            <PromptPanel />
          </>
        )}

        {viewMode === 'prompt-result' && (
          <>
            <PromptPanel />
            <ResultPanel />
          </>
        )}

        {viewMode === 'image-result' && (
          <>
            <ImagePanel />
            <ResultPanel />
          </>
        )}
      </div>

      {isHistoryOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-surface-950/60 backdrop-blur-sm"
          onClick={() => setIsHistoryOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t('history.title')}
        >
          <div
            className="flex h-full w-full max-w-lg animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <History size={16} className="text-accent" />
                <span className="text-sm font-semibold text-ink">{t('history.title')}</span>
              </div>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
                aria-label={t('lab.hideHistory')}
              >
                <X size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-4">
              <RunHistory />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
