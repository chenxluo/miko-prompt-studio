import { CheckCircle2, ListOrdered, Shuffle, Square } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n';

export type RunLimit = number | 'all';
export type RunLimitStrategy = 'first' | 'random';
export type RunConcurrency = 1 | 2 | 4 | 8;
export type RunRetries = 0 | 1 | 3;

interface RunExecutionControlsProps {
  name: string;
  onChangeName: (value: string) => void;
  limit: RunLimit;
  onChangeLimit: (value: RunLimit) => void;
  limitStrategy: RunLimitStrategy;
  onChangeLimitStrategy: (value: RunLimitStrategy) => void;
  concurrency: RunConcurrency;
  onChangeConcurrency: (value: RunConcurrency) => void;
  maxRetries: RunRetries;
  onChangeMaxRetries: (value: RunRetries) => void;
}

const PRESET_LIMITS = [10, 50];
const CONCURRENCY_OPTIONS: RunConcurrency[] = [1, 2, 4, 8];
const RETRY_OPTIONS: RunRetries[] = [0, 1, 3];

export function RunExecutionControls({
  name,
  onChangeName,
  limit,
  onChangeLimit,
  limitStrategy,
  onChangeLimitStrategy,
  concurrency,
  onChangeConcurrency,
  maxRetries,
  onChangeMaxRetries,
}: RunExecutionControlsProps) {
  const { t } = useI18n();
  const [limitInput, setLimitInput] = useState(
    typeof limit === 'number' ? String(limit) : '',
  );

  useEffect(() => {
    setLimitInput(typeof limit === 'number' ? String(limit) : '');
  }, [limit]);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-xs text-ink-muted">{t('runs.runName')}</label>
        <input
          type="text"
          value={name}
          onChange={(event) => onChangeName(event.target.value)}
          placeholder={t('runs.runNamePlaceholder')}
          className="w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-ink-muted">{t('batch.limit')}</label>
        <div className="flex flex-wrap items-center gap-2">
          {[10, 50, 'all' as const].map((value) => (
            <OptionButton
              key={String(value)}
              selected={limit === value}
              onClick={() => onChangeLimit(value)}
              label={
                value === 10
                  ? t('batch.limit10')
                  : value === 50
                    ? t('batch.limit50')
                    : t('batch.limitAll')
              }
            />
          ))}
          <div
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
              typeof limit === 'number' && !PRESET_LIMITS.includes(limit)
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-surface-700 text-ink-muted'
            }`}
          >
            <input
              type="number"
              min={1}
              value={limitInput}
              placeholder={t('batch.limitCustomPlaceholder')}
              disabled={limit === 'all'}
              onChange={(event) => {
                const raw = event.target.value;
                setLimitInput(raw);
                const parsed = Number.parseInt(raw, 10);
                if (parsed >= 1) onChangeLimit(parsed);
              }}
              className="w-16 bg-transparent text-ink placeholder:text-ink-dim focus:outline-none disabled:opacity-50"
            />
            <span className="text-ink-dim">{t('batch.limitUnit')}</span>
          </div>
        </div>
      </div>

      {typeof limit === 'number' && (
        <div>
          <label className="mb-1.5 block text-xs text-ink-muted">
            {t('batch.limitStrategy')}
          </label>
          <div className="flex gap-2">
            {(['first', 'random'] as const).map((value) => (
              <OptionButton
                key={value}
                selected={limitStrategy === value}
                onClick={() => onChangeLimitStrategy(value)}
                icon={value === 'first' ? <ListOrdered size={12} /> : <Shuffle size={12} />}
                label={
                  value === 'first'
                    ? t('batch.limitStrategySequential')
                    : t('batch.limitStrategyRandom')
                }
              />
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-dim">{t('batch.limitStrategyHint')}</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs text-ink-muted">{t('batch.concurrency')}</label>
          <div className="flex flex-wrap gap-2">
            {CONCURRENCY_OPTIONS.map((value) => (
              <OptionButton
                key={value}
                selected={concurrency === value}
                onClick={() => onChangeConcurrency(value)}
                label={`${value}×`}
              />
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-ink-muted">{t('batch.retries')}</label>
          <div className="flex flex-wrap gap-2">
            {RETRY_OPTIONS.map((value) => (
              <OptionButton
                key={value}
                selected={maxRetries === value}
                onClick={() => onChangeMaxRetries(value)}
                label={value === 0 ? t('batch.none') : `×${value}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function OptionButton({
  selected,
  onClick,
  label,
  icon,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors ${
        selected
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-surface-700 text-ink-muted hover:bg-surface-800 hover:text-ink'
      }`}
    >
      {selected ? <CheckCircle2 size={12} /> : <Square size={12} />}
      {icon}
      {label}
    </button>
  );
}
