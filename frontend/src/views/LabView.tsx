import { Database, FlaskConical, History, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import * as api from '../api/client';
import { SamplePickerDialog } from '../components/lab/SamplePickerDialog';
import { ImagePanel } from '../components/lab/ImagePanel';
import { ModelBar } from '../components/lab/ModelBar';
import { PromptPanel } from '../components/lab/PromptPanel';
import { ResultPanel } from '../components/lab/ResultPanel';
import { RunHistory } from '../components/lab/RunHistory';
import { useI18n } from '../i18n';
import { buildDefaultVariables, type LabViewMode, toStableVarString, useLabStore } from '../store/labStore';
import type { ImageRef } from '../types';

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
  const [samplePickerOpen, setSamplePickerOpen] = useState(false);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);

  // Apply a dataset sample: replace Lab images and load its variables. Missing
  // variables fall back to the task defaults (no residual values from a
  // previous sample); non-string values are carried as stable JSON strings.
  const applySample = useCallback((sample: api.SampleListItem) => {
    const state = useLabStore.getState();
    const nextVars = { ...buildDefaultVariables(state.templateVariableSpecs) };
    const rawVars = sample.data?.vars;
    if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
      const source = rawVars as Record<string, unknown>;
      for (const spec of state.templateVariableSpecs) {
        if (source[spec.var_id] === undefined) continue;
        nextVars[spec.var_id] = toStableVarString(source[spec.var_id]);
      }
    }
    const rawImages = sample.data?.images;
    state.setImages(Array.isArray(rawImages) ? (rawImages as ImageRef[]) : []);
    const nextState = useLabStore.getState();
    nextState.setImageSlots(
      nextState.imageSlots.filter((slot) => slot.imageIndex < nextState.images.length),
    );
    state.setVariables(nextVars);
    setActiveSampleId(sample.sample_id);
  }, []);

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
            onClick={() => setSamplePickerOpen(true)}
            aria-label={t('lab.selectFromDataset')}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-900 px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-surface-600 hover:bg-surface-800 hover:text-ink"
          >
            <Database size={14} />
            <span className="hidden sm:inline">{t('lab.selectFromDataset')}</span>
          </button>
          {activeSampleId && (
            <span
              className="inline-flex max-w-[12rem] items-center gap-1.5 truncate rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-xs text-ink-muted"
              title={`${t('lab.activeSample')}: ${activeSampleId}`}
            >
              <span className="shrink-0 text-[10px] text-ink-dim">{t('lab.activeSample')}</span>
              <span className="truncate text-ink">{activeSampleId}</span>
            </span>
          )}

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
      <SamplePickerDialog
        open={samplePickerOpen}
        onClose={() => setSamplePickerOpen(false)}
        onApply={applySample}
      />
    </div>
  );
}
