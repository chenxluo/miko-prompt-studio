import { FlaskConical } from 'lucide-react';

import { ImagePanel } from '../components/lab/ImagePanel';
import { ModelBar } from '../components/lab/ModelBar';
import { PromptPanel } from '../components/lab/PromptPanel';
import { ResultPanel } from '../components/lab/ResultPanel';
import { RunHistory } from '../components/lab/RunHistory';
import { useI18n } from '../i18n';

export function LabView() {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden bg-surface-950 p-4">
      <header className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
          <FlaskConical size={18} strokeWidth={2} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('lab.title')}</h2>
          <p className="text-xs text-ink-dim">{t('lab.description')}</p>
        </div>
      </header>

      <ModelBar />

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2">
        <ImagePanel />
        <PromptPanel />
      </div>

      <ResultPanel />

      <RunHistory />
    </div>
  );
}
