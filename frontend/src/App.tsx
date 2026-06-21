import {
  Beaker,
  FileImage,
  FileText,
  Layers,
  Settings,
  Sparkles,
  Tag,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { LocaleSwitch } from './components/LocaleSwitch';
import { NavButton } from './components/NavButton';
import { LabView } from './views/LabView';
import { SettingsView } from './views/SettingsView';
import { PlaceholderView } from './components/PlaceholderView';
import { useI18n } from './i18n';

type View = 'lab' | 'prompts' | 'samples' | 'runs' | 'pricing' | 'settings';

interface NavItem {
  id: View;
  labelKey: string;
  icon: typeof Beaker;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'lab', labelKey: 'nav.lab', icon: Beaker },
  { id: 'prompts', labelKey: 'nav.prompts', icon: FileText },
  { id: 'samples', labelKey: 'nav.samples', icon: FileImage },
  { id: 'runs', labelKey: 'nav.runs', icon: Layers },
  { id: 'pricing', labelKey: 'nav.pricing', icon: Tag },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
];

const PLACEHOLDER_KEYS: Record<
  Exclude<View, 'lab' | 'settings'>,
  { titleKey: string; descKey: string }
> = {
  prompts: { titleKey: 'nav.prompts', descKey: 'nav.prompts' },
  samples: { titleKey: 'nav.samples', descKey: 'nav.samples' },
  runs: { titleKey: 'nav.runs', descKey: 'nav.runs' },
  pricing: { titleKey: 'nav.pricing', descKey: 'nav.pricing' },
};

export default function App() {
  const [activeView, setActiveView] = useState<View>('lab');
  const { t } = useI18n();

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      const view = event.detail as View;
      if (NAV_ITEMS.some((item) => item.id === view)) {
        setActiveView(view);
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
          <span className="text-xs text-ink-dim">v0.1.0</span>
          <LocaleSwitch />
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        {activeView === 'lab' && <LabView />}
        {activeView === 'settings' && <SettingsView />}
        {activeView !== 'lab' && activeView !== 'settings' && (
          <>
            <header className="flex items-center justify-between border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
              <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
                {t(PLACEHOLDER_KEYS[activeView].titleKey)}
              </h1>
            </header>
            <section className="flex-1 overflow-auto bg-surface-950">
              <PlaceholderView
                title={t(PLACEHOLDER_KEYS[activeView].titleKey)}
                description={t(PLACEHOLDER_KEYS[activeView].descKey)}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
