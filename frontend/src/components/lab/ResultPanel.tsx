import {
  AlertCircle,
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  Clock,
  Coins,
  Cpu,
  ImageIcon,
  Layers,
  Loader2,
  Terminal,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useI18n } from '../../i18n';
import { useSnapshotStore } from '../../store/snapshotStore';
import { useLabStore } from '../../store/labStore';
import type { RunItemType, RunSession, RunItemSummary } from '../../types';
import type { CreateResultSnapshotPayload } from '../../api/payloads';
import { CollapsibleSection } from '../results/CollapsibleSection';
import { ParsedOutputView } from '../results/ParsedOutputView';
import { ReasoningBlock } from '../results/ReasoningBlock';

export function ResultPanel() {
  const { t } = useI18n();
  const isRunning = useLabStore((state) => state.isRunning);
  const lastRunItem = useLabStore((state) => state.lastRunItem);
  const lastResult = useLabStore((state) => state.lastResult);
  const error = useLabStore((state) => state.error);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);

  if (isRunning && !lastRunItem) {
    return (
      <div className="panel flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <Loader2 size={28} className="animate-spin text-accent" />
        <p className="text-sm text-ink-muted">{t('result.runningExperiment')}</p>
      </div>
    );
  }

  if (!lastRunItem) {
    return (
      <div className="panel flex flex-1 flex-col items-center justify-center gap-3 p-6">
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

  const reasoningText = extractReasoningText(response);

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
        <button
          type="button"
          onClick={() => setIsSaveDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/20"
        >
          <Bookmark size={12} className="fill-accent" />
          {t('snapshot.save')}
        </button>
      </div>

      {isSaveDialogOpen && lastResult && (
        <SaveSnapshotDialog
          runSession={lastResult}
          runItem={lastRunItem}
          onClose={() => setIsSaveDialogOpen(false)}
        />
      )}

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

        {isRunning && (
          <div className="flex items-center gap-2 rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-accent">
            <Loader2 size={12} className="animate-spin" />
            {t('result.streaming')}
          </div>
        )}

        <ReasoningBlock reasoningText={reasoningText} />

        <CollapsibleSection title={t('result.raw')} defaultOpen={false} icon={<Terminal size={12} />}>
          <pre className="overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
            {rawText ?? t('result.noRawOutput')}
          </pre>
        </CollapsibleSection>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <CheckCircle2 size={12} />
            {t('result.parsed')}
          </div>
          <ParsedOutputView parsed={parsed} parseStatus={parseStatus} fallbackText={rawText} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UsageBlock usage={usage} />
          <CostBlock cost={cost} />
        </div>
      </div>
    </div>
  );
}

function extractReasoningText(response: Record<string, unknown>): string | undefined {
  const normalized = response.normalized_response;
  if (normalized && typeof normalized === 'object') {
    const value = (normalized as Record<string, unknown>).reasoning_text;
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  const value = response.reasoning_text;
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return undefined;
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
  if (status === 'failed' || status === 'timeout' || status === 'rate_limited' || status === 'blocked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <AlertTriangle size={12} />
        {t('result.failed')}
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-xs font-medium text-ink-muted">
        <XCircle size={12} />
        {t('result.cancelled')}
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-xs font-medium text-ink-muted">
        {t('result.skipped')}
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
    <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
      <AlertTriangle size={12} />
      {status || t('result.error')}
    </span>
  );
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
  latency_ms?: number | null;
  response: Record<string, unknown>;
}): number | undefined {
  // Prefer the top-level latency_ms field persisted on RunItem
  if (typeof item.latency_ms === 'number') {
    return item.latency_ms;
  }
  // Fallback: check response.latency_ms (legacy location)
  const response = item.response;
  if (typeof response.latency_ms === 'number') {
    return response.latency_ms;
  }
  // Fallback: check response.attempt.latency_ms (deep legacy location)
  const attempt = response.attempt;
  if (attempt && typeof attempt === 'object') {
    const attemptRecord = attempt as Record<string, unknown>;
    if (typeof attemptRecord.latency_ms === 'number') {
      return attemptRecord.latency_ms;
    }
  }
  return undefined;
}

function SaveSnapshotDialog({
  runSession,
  runItem,
  onClose,
}: {
  runSession: RunSession;
  runItem: RunItemSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const createSnapshot = useSnapshotStore((state) => state.createSnapshot);
  const activeTaskId = useLabStore((state) => state.activeTaskId);
  const activeTaskVersionId = useLabStore((state) => state.activeTaskVersionId);
  const [name, setName] = useState(runSession.name || `${t('snapshot.title')} ${new Date().toLocaleString()}`);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [starred, setStarred] = useState(false);
  const [setAsTaskExample, setSetAsTaskExample] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      window.alert(t('snapshot.nameRequired'));
      return;
    }
    setIsSaving(true);
    const payload: CreateResultSnapshotPayload = {
      run_id: runSession.run_id,
      run_item_id: runItem.run_item_id,
      name: trimmed,
      description: description.trim() || undefined,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      notes: notes.trim() || undefined,
      starred,
      linked_task_version_id: setAsTaskExample && activeTaskVersionId ? activeTaskVersionId : undefined,
    };
    const snapshot = await createSnapshot(payload);
    setIsSaving(false);
    if (snapshot) {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-lg border border-surface-700 bg-surface-900 p-5 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-4 text-sm font-semibold text-ink">{t('snapshot.save')}</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t('snapshot.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t('snapshot.descriptionLabel')}</label>
            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t('snapshot.tags')}</label>
            <input
              type="text"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={t('snapshot.tagsHint')}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{t('snapshot.notes')}</label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={starred}
              onChange={(event) => setStarred(event.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
            />
            {t('snapshot.starred')}
          </label>
          {activeTaskId && (
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={setAsTaskExample}
                onChange={(event) => setSetAsTaskExample(event.target.checked)}
                className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
              />
              {t('snapshot.setAsTaskExample')}
            </label>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted hover:bg-surface-800"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="btn-primary px-3 py-2 text-xs disabled:opacity-50"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
