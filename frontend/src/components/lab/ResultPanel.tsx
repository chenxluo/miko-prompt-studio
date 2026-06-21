import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  ImageIcon,
  Layers,
  Loader2,
  Terminal,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { useLabStore } from '../../store/labStore';
import type { RunItemType } from '../../types';

export function ResultPanel() {
  const { t } = useI18n();
  const isRunning = useLabStore((state) => state.isRunning);
  const lastRunItem = useLabStore((state) => state.lastRunItem);
  const error = useLabStore((state) => state.error);

  if (isRunning && !lastRunItem) {
    return (
      <div className="panel flex min-h-[12rem] flex-col items-center justify-center gap-3 p-6">
        <Loader2 size={28} className="animate-spin text-accent" />
        <p className="text-sm text-ink-muted">{t('result.runningExperiment')}</p>
      </div>
    );
  }

  if (!lastRunItem) {
    return (
      <div className="panel flex min-h-[12rem] flex-col items-center justify-center gap-3 p-6">
        <Terminal size={28} className="text-ink-dim" />
        <p className="text-sm text-ink-muted">
          {t('result.runToSee')}
        </p>
      </div>
    );
  }

  const status = lastRunItem.status as RunItemType | string;
  const response = lastRunItem.response;
  const usage = lastRunItem.usage;
  const cost = lastRunItem.cost;
  const itemError = lastRunItem.error;
  const latencyMs = findLatencyMs(lastRunItem);

  const rawText =
    typeof response.raw_text === 'string' ? response.raw_text : undefined;
  const parsed = response.parsed;
  const parseStatus =
    typeof response.parse_status === 'string'
      ? response.parse_status
      : undefined;

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <Layers size={16} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{t('result.title')}</span>
          <StatusBadge status={status} />
        </div>
        {latencyMs !== undefined && (
          <div className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Clock size={12} />
            {latencyMs} ms
          </div>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-4">
        {error && (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {itemError && (
          <div className="rounded-md bg-danger/10 px-3 py-3 text-sm text-danger">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <AlertCircle size={14} />
              {typeof itemError.type === 'string' ? itemError.type : t('result.error')}
            </div>
            {typeof itemError.message === 'string' && (
              <p className="text-xs opacity-90">{itemError.message}</p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Terminal size={12} />
            {t('result.raw')}
          </div>
          <pre className="max-h-64 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
            {rawText ?? t('result.noRawOutput')}
          </pre>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <CheckCircle2 size={12} />
            {t('result.parsed')}
          </div>
          <ParsedOutputView parsed={parsed} parseStatus={parseStatus} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UsageBlock usage={usage} />
          <CostBlock cost={cost} />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 size={12} />
        {t('result.succeeded')}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <AlertTriangle size={12} />
        {t('result.failed')}
      </span>
    );
  }
  if (status === 'running' || status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
        <Loader2 size={12} className="animate-spin" />
        {status === 'running' ? t('lab.running') : t('result.pending')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-xs font-medium text-ink-muted">
      {status}
    </span>
  );
}

function ParsedOutputView({
  parsed,
  parseStatus,
}: {
  parsed: unknown;
  parseStatus: string | undefined;
}) {
  const { t } = useI18n();
  if (parseStatus === 'parse_failed') {
    return (
      <div className="rounded-md bg-danger/10 px-3 py-3 text-sm text-danger">
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <AlertTriangle size={14} />
          {t('result.parseFailed')}
        </div>
      </div>
    );
  }

  if (parseStatus === 'parsed' && parsed !== undefined) {
    return (
      <pre className="max-h-64 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
        {formatParsedOutput(parsed)}
      </pre>
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
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
            {formatParsedOutput(parsed)}
          </pre>
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

function formatParsedOutput(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}

function UsageBlock({ usage }: { usage: Record<string, unknown> }) {
  const { t } = useI18n();
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : inputTokens + outputTokens;
  const imageCount =
    typeof usage.image_count === 'number' ? usage.image_count : 0;

  return (
    <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Cpu size={12} />
        {t('result.usage')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <UsageMetric label={t('result.inputTokens')} value={inputTokens} />
        <UsageMetric label={t('result.outputTokens')} value={outputTokens} />
        <UsageMetric label={t('result.totalTokens')} value={totalTokens} />
        <UsageMetric
          label={t('result.image')}
          value={imageCount}
          icon={<ImageIcon size={12} className="text-ink-dim" />}
        />
      </div>
    </div>
  );
}

function UsageMetric({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded bg-surface-900 px-2 py-1.5">
      <div className="flex items-center gap-1 text-xs text-ink-dim">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold text-ink">{value.toLocaleString()}</div>
    </div>
  );
}

function CostBlock({ cost }: { cost: Record<string, unknown> }) {
  const { t } = useI18n();
  const estimated =
    typeof cost.estimated_cost === 'number' ? cost.estimated_cost : 0;
  const currency =
    typeof cost.currency === 'string' ? cost.currency : 'USD';
  const breakdown =
    cost.cost_breakdown && typeof cost.cost_breakdown === 'object'
      ? (cost.cost_breakdown as Record<string, unknown>)
      : {};

  const inputText =
    typeof breakdown.input_text === 'number' ? breakdown.input_text : 0;
  const outputText =
    typeof breakdown.output_text === 'number' ? breakdown.output_text : 0;
  const imageInput =
    typeof breakdown.image_input === 'number' ? breakdown.image_input : 0;

  return (
    <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Coins size={12} />
        {t('result.cost')}
      </div>
      <div className="mb-3 text-lg font-semibold text-cost">
        {currency} {estimated.toFixed(6)}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <CostMetric label={t('result.inputTokens')} value={inputText} />
        <CostMetric label={t('result.outputTokens')} value={outputText} />
        <CostMetric label={t('result.image')} value={imageInput} />
      </div>
    </div>
  );
}

function CostMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-surface-900 px-2 py-1.5">
      <div className="text-xs text-ink-dim">{label}</div>
      <div className="text-xs font-semibold text-ink">{value.toFixed(6)}</div>
    </div>
  );
}

function findLatencyMs(item: {
  response: Record<string, unknown>;
}): number | undefined {
  const response = item.response;
  if (typeof response.latency_ms === 'number') {
    return response.latency_ms;
  }
  const attempt = response.attempt;
  if (attempt && typeof attempt === 'object') {
    const attemptRecord = attempt as Record<string, unknown>;
    if (typeof attemptRecord.latency_ms === 'number') {
      return attemptRecord.latency_ms;
    }
  }
  return undefined;
}
