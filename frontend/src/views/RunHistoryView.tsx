import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Code,
  Eye,
  FileDown,
  History,
  Loader2,
  Search,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import * as api from '../api/client';
import { useI18n } from '../i18n';
import type { RunItemSummary, RunSessionStatus, RunType } from '../types';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: RunSessionStatus[] = [
  'completed',
  'completed_with_errors',
  'running',
  'failed',
  'cancelled',
];

const TYPE_OPTIONS: RunType[] = ['lab', 'batch', 'compare'];

export function RunHistoryView() {
  const { t } = useI18n();
  const [runs, setRuns] = useState<api.RunListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<RunSessionStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<RunType | ''>('');
  const [offset, setOffset] = useState(0);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Debounce search input.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput);
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setOffset(0);
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await api.listRuns({
          run_type: typeFilter || undefined,
          status: statusFilter || undefined,
          search: searchQuery || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (cancelled) return;
        setRuns(result.runs);
        setTotal(result.total);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('runs.loadFailed'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [searchQuery, statusFilter, typeFilter, offset, t]);

  async function handleDelete(run: api.RunListItem) {
    if (!window.confirm(t('history.confirmDelete'))) return;
    setDeletingId(run.run_id);
    setError(null);
    try {
      await api.deleteRun(run.run_id);
      setRuns((current) => current.filter((item) => item.run_id !== run.run_id));
      setTotal((current) => Math.max(0, current - 1));
      if (selectedRunId === run.run_id) {
        setSelectedRunId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('runs.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-950">
      <header className="flex flex-col gap-3 border-b border-surface-800 bg-surface-900/50 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('history.title')}
          </h1>
          <p className="mt-1 text-xs text-ink-dim">{t('runs.description')}</p>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            />
            <input
              type="text"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('runs.search')}
              className="w-full rounded-md border border-surface-700 bg-surface-900 py-2 pl-9 pr-3 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <FilterSelect
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as RunSessionStatus | '')}
              placeholder={t('runs.statusAll')}
              options={STATUS_OPTIONS.map((status) => ({
                value: status,
                label: t(statusLabelKey(status)),
              }))}
            />
            <FilterSelect
              value={typeFilter}
              onChange={(value) => setTypeFilter(value as RunType | '')}
              placeholder={t('runs.typeAll')}
              options={TYPE_OPTIONS.map((runType) => ({
                value: runType,
                label: t(typeLabelKey(runType)),
              }))}
            />
          </div>
        </div>
      </header>

      <section className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {isLoading && runs.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
            <Loader2 size={16} className="mr-2 animate-spin" />
            {t('history.loading')}
          </div>
        ) : runs.length === 0 ? (
          <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
            {total === 0 ? t('runs.empty') : t('runs.noResults')}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border border-surface-700">
              <div className="max-h-[calc(100vh-16rem)] overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-surface-900">
                    <tr className="border-b border-surface-700 text-ink-muted">
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.name')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.type')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.status')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.sampleCount')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.totalCost')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.createdAt')}
                      </th>
                      <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                        {t('runs.column.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-800">
                    {runs.map((run) => (
                      <RunHistoryTableRow
                        key={run.run_id}
                        run={run}
                        isDeleting={deletingId === run.run_id}
                        onView={() => setSelectedRunId(run.run_id)}
                        onDelete={() => void handleDelete(run)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink disabled:opacity-50"
                >
                  <ChevronLeft size={14} />
                  {t('common.cancel')}
                </button>
                <span className="text-xs text-ink-dim">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total}
                  className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink disabled:opacity-50"
                >
                  {t('common.confirm')}
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {selectedRunId && (
        <RunDetailDrawer
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
          onDelete={(run) => void handleDelete(run)}
          deletingId={deletingId}
        />
      )}
    </div>
  );
}

interface RunHistoryTableRowProps {
  run: api.RunListItem;
  isDeleting: boolean;
  onView: () => void;
  onDelete: () => void;
}

function RunHistoryTableRow({
  run,
  isDeleting,
  onView,
  onDelete,
}: RunHistoryTableRowProps) {
  const { t } = useI18n();
  const summary = run.summary || {};
  const sampleCount = typeof summary.total_items === 'number' ? summary.total_items : 0;
  const totalCost = typeof summary.total_cost_estimated === 'number'
    ? summary.total_cost_estimated
    : 0;
  const currency = typeof summary.currency === 'string' ? summary.currency : 'USD';
  const createdAt = run.created_at
    ? new Date(run.created_at).toLocaleString()
    : '—';

  return (
    <tr className="bg-surface-950 transition-colors hover:bg-surface-900/50">
      <td className="px-4 py-3 align-top">
        <div className="font-medium text-ink">{run.name || run.run_id}</div>
        {run.name && (
          <div className="mt-0.5 font-mono text-[10px] text-ink-dim">{run.run_id}</div>
        )}
      </td>
      <td className="px-4 py-3 align-top text-ink-muted">
        {t(typeLabelKey(run.run_type))}
      </td>
      <td className="px-4 py-3 align-top">
        <RunStatusBadge status={run.status as RunSessionStatus} />
      </td>
      <td className="px-4 py-3 align-top text-ink-muted">{sampleCount.toLocaleString()}</td>
      <td className="px-4 py-3 align-top font-medium text-cost">
        {currency} {totalCost.toFixed(6)}
      </td>
      <td className="px-4 py-3 align-top text-ink-muted">{createdAt}</td>
      <td className="px-4 py-3 align-top">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onView}
            className="btn-primary px-2.5 py-1.5 text-xs"
          >
            <Eye size={12} />
            {t('runs.view')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            {t('runs.delete')}
          </button>
        </div>
      </td>
    </tr>
  );
}

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
}

function FilterSelect({ value, onChange, placeholder, options }: FilterSelectProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface RunDetailDrawerProps {
  runId: string;
  onClose: () => void;
  onDelete: (run: api.RunListItem) => void;
  deletingId: string | null;
}

function RunDetailDrawer({
  runId,
  onClose,
  onDelete,
  deletingId,
}: RunDetailDrawerProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<api.RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<RunItemSummary | null>(null);
  const [exportingFormat, setExportingFormat] = useState<'jsonl' | 'csv' | 'html' | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const data = await api.getRun(runId);
        if (cancelled) return;
        setDetail(data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('runs.loadFailed'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, t]);

  async function handleExport(format: 'jsonl' | 'csv' | 'html') {
    setExportingFormat(format);
    try {
      if (format === 'jsonl') {
        await api.exportRunJsonl(runId);
      } else if (format === 'html') {
        await api.exportRunHtml(runId);
      } else {
        await api.exportRunCsv(runId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('runs.loadFailed'));
    } finally {
      setExportingFormat(null);
    }
  }

  const session = detail?.session;
  const config = session?.config_snapshot || {};
  const promptVersion =
    config.prompt_version && typeof config.prompt_version === 'object'
      ? (config.prompt_version as Record<string, unknown>)
      : {};
  const modelConfig =
    config.model_config_snapshot && typeof config.model_config_snapshot === 'object'
      ? (config.model_config_snapshot as Record<string, unknown>)
      : {};
  const outputContract =
    config.output_contract && typeof config.output_contract === 'object'
      ? (config.output_contract as Record<string, unknown>)
      : {};

  const createdAt = session?.created_at
    ? new Date(session.created_at).toLocaleString()
    : '—';
  const systemPrompt =
    typeof promptVersion.system_prompt === 'string' ? promptVersion.system_prompt : '';
  const userPrompt =
    typeof promptVersion.user_template === 'string' ? promptVersion.user_template : '';
  const modelId = typeof modelConfig.model_id === 'string' ? modelConfig.model_id : '';
  const providerId =
    typeof modelConfig.provider_id === 'string' ? modelConfig.provider_id : '';
  const outputMode =
    typeof outputContract.mode === 'string' ? outputContract.mode : '';

  return (
    <div
      className="fixed inset-0 z-50 flex bg-surface-950/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={session?.name || runId}
    >
      <div
        className="ml-auto flex h-full w-full max-w-3xl animate-fade-in flex-col border-l border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <History size={16} className="text-accent" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">
                {session?.name || runId}
              </div>
              {session?.name && (
                <div className="font-mono text-[10px] text-ink-dim">{runId}</div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('history.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex h-40 items-center justify-center text-sm text-ink-muted">
              <Loader2 size={16} className="mr-2 animate-spin" />
              {t('history.loading')}
            </div>
          ) : !session ? (
            <div className="panel flex h-48 items-center justify-center text-sm text-ink-dim">
              {t('runs.empty')}
            </div>
          ) : (
            <div className="space-y-5">
              <section className="panel p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  {t('history.sessionInfo')}
                </h3>
                <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
                  <ReadonlyRow label={t('history.runId')} value={session.run_id} />
                  <ReadonlyRow label={t('history.runType')} value={t(typeLabelKey(session.run_type))} />
                  <ReadonlyRow
                    label={t('history.status')}
                    value={<RunStatusBadge status={session.status as RunSessionStatus} />}
                  />
                  <ReadonlyRow label={t('history.created')} value={createdAt} />
                  {session.name && (
                    <ReadonlyRow label={t('history.name')} value={session.name} />
                  )}
                </div>
              </section>

              <section className="panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                    {t('history.configSnapshot')}
                  </h3>
                </div>
                <div className="space-y-3 text-xs">
                  {systemPrompt ? (
                    <ReadonlyCodeField label={t('history.systemPrompt')} value={systemPrompt} />
                  ) : null}
                  {userPrompt ? (
                    <ReadonlyCodeField label={t('history.userPrompt')} value={userPrompt} />
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <ReadonlyRow label={t('history.modelId')} value={modelId || '—'} />
                    <ReadonlyRow label={t('history.providerId')} value={providerId || '—'} />
                    <ReadonlyRow
                      label={t('history.outputContractMode')}
                      value={outputMode || '—'}
                    />
                  </div>
                  {!systemPrompt && !userPrompt && !modelId && !providerId && !outputMode && (
                    <p className="text-ink-dim">{t('history.noConfig')}</p>
                  )}
                </div>
              </section>

              <section>
                <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                    {t('history.items')}
                  </h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleExport('jsonl')}
                      disabled={exportingFormat === 'jsonl'}
                      className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      {exportingFormat === 'jsonl' ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <FileDown size={12} />
                      )}
                      {t('history.exportJsonl')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleExport('csv')}
                      disabled={exportingFormat === 'csv'}
                      className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      {exportingFormat === 'csv' ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Download size={12} />
                      )}
                      {t('history.exportCsv')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleExport('html')}
                      disabled={exportingFormat === 'html'}
                      className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
                    >
                      {exportingFormat === 'html' ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Code size={12} />
                      )}
                      {t('history.exportHtml')}
                    </button>
                  </div>
                </div>

                {detail?.items.length === 0 ? (
                  <div className="panel flex h-32 items-center justify-center text-sm text-ink-dim">
                    {t('history.noItems')}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-surface-700">
                    <div className="max-h-[calc(100vh-24rem)] overflow-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 z-10 bg-surface-900">
                          <tr className="border-b border-surface-700 text-ink-muted">
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('batch.sampleId')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('batch.status')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('batch.cost')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('batch.latency')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('history.tokens')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('history.responsePreview')}
                            </th>
                            <th className="px-4 py-3 font-semibold uppercase tracking-wider">
                              {t('history.reviewStatus')}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-surface-800">
                          {(detail?.items || []).map((item) => (
                            <tr
                              key={item.run_item_id}
                              onClick={() => setSelectedItem(item)}
                              className="cursor-pointer bg-surface-950 transition-colors hover:bg-surface-900/50"
                            >
                              <td className="px-4 py-3 align-top font-mono text-ink">
                                {item.sample_id}
                              </td>
                              <td className="px-4 py-3 align-top">
                                <RunStatusBadge status={item.status as RunSessionStatus} />
                              </td>
                              <td className="px-4 py-3 align-top text-ink">
                                {item.estimated_cost.toFixed(6)}
                              </td>
                              <td className="px-4 py-3 align-top text-ink-muted">
                                {formatLatency(item.latency_ms)}
                              </td>
                              <td className="px-4 py-3 align-top text-ink-muted">
                                {formatTokens(item.usage)}
                              </td>
                              <td className="px-4 py-3 align-top text-ink-muted">
                                <span className="max-w-xs truncate">
                                  {truncateText(extractRawText(item.response), 100) || t('history.noResponse')}
                                </span>
                              </td>
                              <td className="px-4 py-3 align-top">
                                <ReviewStatusBadge review={item.review} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => session && onDelete(session)}
                  disabled={deletingId === session.run_id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 px-3 py-2 text-xs text-ink-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
                >
                  {deletingId === session.run_id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {t('runs.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedItem && (
        <RunItemModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}

interface RunItemModalProps {
  item: RunItemSummary;
  onClose: () => void;
}

function RunItemModal({ item, onClose }: RunItemModalProps) {
  const { t } = useI18n();
  const rawText = extractRawText(item.response);
  const parsed = item.response?.parsed;
  const parseStatus =
    typeof item.response?.parse_status === 'string'
      ? item.response.parse_status
      : undefined;
  const usage = item.usage || {};
  const cost = item.cost || {};
  const error = item.error;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('history.itemDetail')}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="font-mono text-xs text-ink-dim">{item.sample_id}</span>
            <span className="text-ink-muted">·</span>
            <RunStatusBadge status={item.status as RunSessionStatus} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink"
            aria-label={t('history.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {rawText && (
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">{t('history.rawText')}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
                {rawText}
              </pre>
            </div>
          )}

          {parsed !== undefined && parseStatus !== 'not_parsed' && parseStatus !== 'parse_failed' && (
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">{t('history.parsed')}</div>
              <pre className="max-h-64 overflow-auto rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-xs text-ink">
                {formatParsedOutput(parsed)}
              </pre>
            </div>
          )}

          {parseStatus === 'parse_failed' && typeof parsed === 'string' && parsed && (
            <div className="rounded-md border border-danger/20 bg-danger/5 p-3">
              <div className="mb-1 text-xs font-medium text-danger">{t('result.parseFailed')}</div>
              <div className="markdown-body text-xs text-ink">
                <ReactMarkdown>{parsed}</ReactMarkdown>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
              <div className="mb-2 text-xs font-medium text-ink-muted">{t('result.usage')}</div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label={t('result.inputTokens')} value={formatNumber(usage.input_tokens)} />
                <Metric label={t('result.outputTokens')} value={formatNumber(usage.output_tokens)} />
                <Metric label={t('result.totalTokens')} value={formatNumber(usage.total_tokens)} />
                <Metric label={t('result.image')} value={formatNumber(usage.image_count)} />
              </div>
            </div>

            <div className="rounded-md border border-surface-800 bg-surface-950 p-3">
              <div className="mb-2 text-xs font-medium text-ink-muted">{t('result.cost')}</div>
              <div className="text-lg font-semibold text-cost">
                {typeof cost.currency === 'string' ? cost.currency : 'USD'}{' '}
                {typeof cost.estimated_cost === 'number'
                  ? cost.estimated_cost.toFixed(6)
                  : item.estimated_cost.toFixed(6)}
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-danger/20 bg-danger/5 p-3">
              <div className="mb-1 text-xs font-medium text-danger">{t('history.error')}</div>
              <pre className="overflow-auto rounded-md bg-surface-950 p-2 font-mono text-[11px] text-ink">
                {formatParsedOutput(error)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string | undefined }) {
  const { t } = useI18n();

  if (status === 'completed' || status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 size={10} />
        {t('history.statusCompleted')}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
        <XCircle size={10} />
        {t('history.statusFailed')}
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
        <Loader2 size={10} className="animate-spin" />
        {t('history.statusRunning')}
      </span>
    );
  }
  if (status === 'completed_with_errors') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-cost/10 px-2 py-0.5 text-[10px] font-medium text-cost">
        <AlertCircle size={10} />
        {t('history.statusPartial')}
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
        <Square size={10} />
        {t('history.statusCancelled')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {status ?? t('history.statusUnknown')}
    </span>
  );
}

function ReviewStatusBadge({ review }: { review: Record<string, unknown> }) {
  const { t } = useI18n();
  const accepted = review?.accepted;

  if (accepted === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 size={10} />
        {t('history.reviewAccepted')}
      </span>
    );
  }
  if (accepted === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
        <XCircle size={10} />
        {t('history.reviewRejected')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {t('history.reviewPending')}
    </span>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-ink-dim">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

function ReadonlyCodeField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-dim">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-surface-800 bg-surface-950 p-3 font-mono text-[11px] text-ink">
        {value}
      </pre>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded bg-surface-900 px-2 py-1.5">
      <div className="text-xs text-ink-dim">{label}</div>
      <div className="text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function extractRawText(response: Record<string, unknown> | undefined): string {
  if (!response) return '';
  const raw = response.raw_text;
  if (typeof raw === 'string') return raw;
  const text = response.text;
  if (typeof text === 'string') return text;
  return '';
}

function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function statusLabelKey(status: string): string {
  switch (status) {
    case 'completed':
      return 'history.statusCompleted';
    case 'completed_with_errors':
      return 'history.statusPartial';
    case 'running':
      return 'history.statusRunning';
    case 'failed':
      return 'history.statusFailed';
    case 'cancelled':
      return 'history.statusCancelled';
    default:
      return 'history.statusUnknown';
  }
}

function typeLabelKey(runType: string): string {
  switch (runType) {
    case 'lab':
      return 'history.typeLab';
    case 'batch':
      return 'history.typeBatch';
    case 'compare':
      return 'history.typeCompare';
    default:
      return 'history.typeOther';
  }
}

function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTokens(usage: Record<string, unknown> | undefined): string {
  if (!usage) return '—';
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
  if (total !== null) return total.toLocaleString();
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return (input + output).toLocaleString();
}

function formatNumber(value: unknown): string | number {
  if (typeof value === 'number') return value.toLocaleString();
  return '—';
}

function formatParsedOutput(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}

