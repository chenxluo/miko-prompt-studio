import {
  Beaker,
  BarChart3,
  Bookmark,
  Eye,
  FileImage,
  FileText,
  GitCompare,
  Layers,
  ListChecks,
  Settings,
  Sparkles,
  Calculator,
  Workflow,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { LocaleSwitch } from './components/LocaleSwitch';
import { NavButton } from './components/NavButton';
import { LabView } from './views/LabView';
import { SettingsView } from './views/SettingsView';
import { TasksView } from './views/TasksView';
import { PromptsView } from './views/PromptsView';
import { SnapshotsView } from './views/SnapshotsView';
import { SamplesView } from './views/SamplesView';
import { RunsView } from './views/RunsView';
import { PipelineView } from './views/PipelineView';
import { CostView } from './views/CostView';
import { ResultsView } from './views/ResultsView';
import { CompareResultsView } from './views/CompareResultsView';
import { AnalyticsView } from './views/AnalyticsView';
import { useI18n } from './i18n';

// Injected at build time by Vite (define) from the root package.json version.
declare const __APP_VERSION__: string;

type View = 'lab' | 'tasks' | 'prompts' | 'samples' | 'runs' | 'pipelines' | 'results' | 'compareResults' | 'analytics' | 'snapshots' | 'cost' | 'settings';

interface NavItem {
  id: View;
  labelKey: string;
  icon: typeof Beaker;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'lab', labelKey: 'nav.lab', icon: Beaker },
  { id: 'tasks', labelKey: 'nav.tasks', icon: ListChecks },
  { id: 'prompts', labelKey: 'nav.prompts', icon: FileText },
  { id: 'samples', labelKey: 'nav.samples', icon: FileImage },
  { id: 'runs', labelKey: 'nav.runs', icon: Layers },
  { id: 'pipelines', labelKey: 'nav.pipelines', icon: Workflow },
  { id: 'results', labelKey: 'nav.results', icon: Eye },
  { id: 'compareResults', labelKey: 'nav.compareResults', icon: GitCompare },
  { id: 'analytics', labelKey: 'nav.analytics', icon: BarChart3 },
  { id: 'snapshots', labelKey: 'nav.snapshots', icon: Bookmark },
  { id: 'cost', labelKey: 'nav.cost', icon: Calculator },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
];

export default function App() {
  const [activeView, setActiveView] = useState<View>('lab');
  const [resultsRunId, setResultsRunId] = useState<string | null>(null);
  const [compareResultsRunId, setCompareResultsRunId] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      const detail = event.detail as View | { view: View; runId?: string } | null | undefined;
      if (typeof detail === 'string') {
        if (NAV_ITEMS.some((item) => item.id === detail)) {
          setActiveView(detail);
        }
      } else if (detail && typeof detail === 'object' && detail.view) {
        if (NAV_ITEMS.some((item) => item.id === detail.view)) {
          setActiveView(detail.view);
        }
        if (detail.view === 'results' && detail.runId) {
          setResultsRunId(detail.runId);
        }
        if (detail.view === 'compareResults' && detail.runId) {
          setCompareResultsRunId(detail.runId);
        }
      }
    };
    window.addEventListener('miko:navigate', handler as EventListener);
    return () => window.removeEventListener('miko:navigate', handler as EventListener);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-950">
      <aside className="flex w-64 flex-col border-r border-surface-800 bg-surface-900">
        <div className="flex items-center gap-3 border-b border-surface-800 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-surface-950 shadow-glow">
            <Sparkles size={18} strokeWidth={2.5} />
          </div>
          <div className="flex flex-col">
            <span className="font-sans text-base font-bold tracking-tight text-ink">
              {t('app.title')}
            </span>
            <span className="text-[10px] text-ink-dim">{t('app.subtitle')}</span>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_ITEMS.map((item) => (
            <NavButton
              key={item.id}
              icon={item.icon}
              label={t(item.labelKey)}
              isActive={activeView === item.id}
              onClick={() => setActiveView(item.id)}
            />
          ))}
        </nav>

        <div className="flex items-center justify-between border-t border-surface-800 px-4 py-3">
          <span className="text-xs text-ink-dim">v{__APP_VERSION__}</span>
          <LocaleSwitch />
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {activeView === 'lab' && <LabView />}
        {activeView === 'tasks' && <TasksView />}
        {activeView === 'prompts' && <PromptsView />}
        {activeView === 'samples' && <SamplesView />}
        {activeView === 'runs' && <RunsView />}
        {activeView === 'pipelines' && <PipelineView />}
        {activeView === 'results' && <ResultsView initialRunId={resultsRunId} />}
        {activeView === 'compareResults' && <CompareResultsView initialRunId={compareResultsRunId} />}
        {activeView === 'analytics' && <AnalyticsView />}
        {activeView === 'snapshots' && <SnapshotsView />}
        {activeView === 'cost' && <CostView />}
        {activeView === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
