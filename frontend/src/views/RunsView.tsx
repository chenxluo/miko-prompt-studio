import { Beaker, GitCompare, History } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../i18n';
import { BatchView } from './BatchView';
import { CompareRunView } from './CompareView';
import { RunHistoryView } from './RunHistoryView';

type RunsTab = 'batch' | 'compare' | 'history';

export function RunsView() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<RunsTab>('batch');

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex flex-col border-b border-surface-800 bg-surface-900/50 backdrop-blur">
        <div className="flex items-center justify-between px-6 py-3">
          <div>
            <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
              {t('runs.title')}
            </h1>
            <p className="mt-1 text-xs text-ink-dim">{t('runs.description')}</p>
          </div>
        </div>

        <div className="flex gap-1 px-6 pb-2">
          <TabButton
            isActive={activeTab === 'batch'}
            onClick={() => setActiveTab('batch')}
            icon={Beaker}
            label={t('runs.tabBatchTest')}
          />
          <TabButton
            isActive={activeTab === 'compare'}
            onClick={() => setActiveTab('compare')}
            icon={GitCompare}
            label={t('runs.tabCompare')}
          />
          <TabButton
            isActive={activeTab === 'history'}
            onClick={() => setActiveTab('history')}
            icon={History}
            label={t('runs.tabRunHistory')}
          />
        </div>
      </header>

      <section className="flex-1 overflow-hidden">
        {activeTab === 'batch' && <BatchView />}
        {activeTab === 'compare' && <CompareRunView />}
        {activeTab === 'history' && <RunHistoryView />}
      </section>
    </div>
  );
}

interface TabButtonProps {
  isActive: boolean;
  onClick: () => void;
  icon: typeof Beaker;
  label: string;
}

function TabButton({ isActive, onClick, icon: Icon, label }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
        isActive
          ? 'border-accent text-accent'
          : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
