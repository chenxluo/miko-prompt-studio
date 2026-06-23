import {
  FileJson,
  FileSpreadsheet,
  Loader2,
  Table2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  importCsvFile,
  importJsonlFile,
  previewCsvFile,
} from '../../api/client';
import { useI18n } from '../../i18n';

type Tab = 'csv' | 'jsonl';

interface ImageColumnState {
  selected: boolean;
  role: string;
}

interface ImportDialogProps {
  onClose: () => void;
  onImported: (sampleSetId: string) => void;
}

export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('csv');

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [jsonlFile, setJsonlFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState(',');

  const [previewColumns, setPreviewColumns] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const [idColumn, setIdColumn] = useState('');
  const [imageColumns, setImageColumns] = useState<Record<string, ImageColumnState>>(
    {},
  );
  const [varColumns, setVarColumns] = useState<Set<string>>(new Set());
  const [metadataColumns, setMetadataColumns] = useState<Set<string>>(new Set());
  const [baseDir, setBaseDir] = useState('');

  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableColumns = useMemo(() => previewColumns, [previewColumns]);

  useEffect(() => {
    if (!csvFile || activeTab !== 'csv') return;
    let cancelled = false;
    async function loadPreview() {
      const file = csvFile;
      if (!file) return;
      setIsPreviewLoading(true);
      setError(null);
      try {
        const preview = await previewCsvFile(file, delimiter || ',');
        if (cancelled) return;
        setPreviewColumns(preview.columns);
        setPreviewRows(preview.rows.slice(0, 10));

        const idCandidate =
          preview.columns.find((col) => col.toLowerCase() === 'id') ??
          preview.columns[0] ??
          '';
        setIdColumn(idCandidate);

        const nextImageColumns: Record<string, ImageColumnState> = {};
        const nextVarColumns = new Set<string>();
        const nextMetadataColumns = new Set<string>();
        for (const column of preview.columns) {
          const lower = column.toLowerCase();
          if (lower === 'image' || lower.startsWith('image_') || lower.endsWith('_image')) {
            nextImageColumns[column] = { selected: true, role: 'target' };
          } else if (lower === 'id') {
            // ID column is handled separately.
          } else if (lower.startsWith('meta_') || lower.startsWith('metadata_')) {
            nextMetadataColumns.add(column);
          } else {
            nextVarColumns.add(column);
          }
        }
        setImageColumns(nextImageColumns);
        setVarColumns(nextVarColumns);
        setMetadataColumns(nextMetadataColumns);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('samples.previewFailed'));
        setPreviewColumns([]);
        setPreviewRows([]);
      } finally {
        if (!cancelled) setIsPreviewLoading(false);
      }
    }
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [csvFile, delimiter, activeTab, t]);

  function handleCsvFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setCsvFile(file);
    setPreviewColumns([]);
    setPreviewRows([]);
    setIdColumn('');
    setImageColumns({});
    setVarColumns(new Set());
    setMetadataColumns(new Set());
    setError(null);
  }

  function handleJsonlFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setJsonlFile(file);
    setError(null);
  }

  function toggleImageColumn(column: string) {
    setImageColumns((prev) => {
      const current = prev[column] ?? { selected: false, role: 'target' };
      return {
        ...prev,
        [column]: { ...current, selected: !current.selected },
      };
    });
  }

  function setImageRole(column: string, role: string) {
    setImageColumns((prev) => ({
      ...prev,
      [column]: { ...(prev[column] ?? { selected: true }), role },
    }));
  }

  function toggleVarColumn(column: string) {
    setVarColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }

  function toggleMetadataColumn(column: string) {
    setMetadataColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }

  async function handleImport() {
    setError(null);
    setIsImporting(true);
    try {
        if (activeTab === 'csv') {
          if (!csvFile) throw new Error(t('samples.noFileSelected'));
          if (!idColumn) throw new Error(t('samples.idColumnRequired'));
          const mapping = buildMapping();
          const result = await importCsvFile(csvFile, mapping, delimiter || ',');
          if ('sample_set_id' in result) {
            onImported(result.sample_set_id);
          }
        } else {
          if (!jsonlFile) throw new Error(t('samples.noFileSelected'));
          const result = await importJsonlFile(jsonlFile);
          if ('sample_set_id' in result) {
            onImported(result.sample_set_id);
          }
        }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('samples.importFailed'));
    } finally {
      setIsImporting(false);
    }
  }

  function buildMapping() {
    const selectedImages = Object.entries(imageColumns)
      .filter(([, state]) => state.selected)
      .map(([column, state]) => ({ column, role: state.role || 'target' }));
    return {
      id_column: idColumn,
      image_columns: selectedImages,
      var_columns: Array.from(varColumns),
      metadata_columns: Array.from(metadataColumns),
      base_dir: baseDir.trim() || undefined,
    };
  }

  const canImport =
    !isImporting &&
    (activeTab === 'csv'
      ? Boolean(csvFile) && Boolean(idColumn)
      : Boolean(jsonlFile));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('samples.import')}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t('samples.import')}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isImporting}
            className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink disabled:opacity-50"
            aria-label={t('common.cancel')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="border-b border-surface-800 px-4">
          <div className="flex gap-4">
            <TabButton
              active={activeTab === 'csv'}
              onClick={() => setActiveTab('csv')}
              icon={<FileSpreadsheet size={14} />}
              label={t('samples.tabCsv')}
            />
            <TabButton
              active={activeTab === 'jsonl'}
              onClick={() => setActiveTab('jsonl')}
              icon={<FileJson size={14} />}
              label={t('samples.tabJsonl')}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {activeTab === 'csv' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-ink-muted">
                    {t('samples.csvFile')}
                  </label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleCsvFileChange}
                    className="block w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink file:mr-3 file:rounded-md file:border-0 file:bg-surface-800 file:px-3 file:py-1 file:text-xs file:text-ink hover:file:bg-surface-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-ink-muted">
                    {t('samples.delimiter')}
                  </label>
                  <input
                    type="text"
                    value={delimiter}
                    onChange={(event) => setDelimiter(event.target.value)}
                    placeholder=","
                    className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                  />
                </div>
              </div>

              {isPreviewLoading && (
                <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
                  <Loader2 size={14} className="mr-2 animate-spin" />
                  {t('samples.previewLoading')}
                </div>
              )}

              {availableColumns.length > 0 && !isPreviewLoading && (
                <>
                  <div className="panel p-4">
                    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                      {t('samples.columnMapping')}
                    </h3>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs text-ink-muted">
                          {t('samples.idColumn')}
                        </label>
                        <select
                          value={idColumn}
                          onChange={(event) => setIdColumn(event.target.value)}
                          className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                        >
                          <option value="">—</option>
                          {availableColumns.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-ink-muted">
                          {t('samples.baseDir')}
                        </label>
                        <input
                          type="text"
                          value={baseDir}
                          onChange={(event) => setBaseDir(event.target.value)}
                          placeholder={t('samples.baseDirHint')}
                          className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      <MappingGroup title={t('samples.imageColumns')}>
                        {availableColumns.map((column) => {
                          const state = imageColumns[column] ?? {
                            selected: false,
                            role: 'target',
                          };
                          return (
                            <div
                              key={`img-${column}`}
                              className="flex items-center gap-3"
                            >
                              <label className="flex items-center gap-2 text-xs text-ink-muted">
                                <input
                                  type="checkbox"
                                  checked={state.selected}
                                  onChange={() => toggleImageColumn(column)}
                                  className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                                />
                                {column}
                              </label>
                              {state.selected && (
                                <input
                                  type="text"
                                  value={state.role}
                                  onChange={(event) =>
                                    setImageRole(column, event.target.value)
                                  }
                                  placeholder={t('samples.imageRole')}
                                  className="w-32 rounded-md border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                                />
                              )}
                            </div>
                          );
                        })}
                      </MappingGroup>

                      <MappingGroup title={t('samples.varColumns')}>
                        {availableColumns.map((column) => (
                          <label
                            key={`var-${column}`}
                            className="flex items-center gap-2 text-xs text-ink-muted"
                          >
                            <input
                              type="checkbox"
                              checked={varColumns.has(column)}
                              onChange={() => toggleVarColumn(column)}
                              className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                            />
                            {column}
                          </label>
                        ))}
                      </MappingGroup>

                      <MappingGroup title={t('samples.metadataColumns')}>
                        {availableColumns.map((column) => (
                          <label
                            key={`meta-${column}`}
                            className="flex items-center gap-2 text-xs text-ink-muted"
                          >
                            <input
                              type="checkbox"
                              checked={metadataColumns.has(column)}
                              onChange={() => toggleMetadataColumn(column)}
                              className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                            />
                            {column}
                          </label>
                        ))}
                      </MappingGroup>
                    </div>
                  </div>

                  {previewRows.length > 0 && (
                    <div className="panel overflow-hidden">
                      <div className="flex items-center gap-2 border-b border-surface-700 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                        <Table2 size={12} />
                        {t('samples.preview')}
                      </div>
                      <div className="max-h-64 overflow-auto">
                        <table className="w-full text-left text-[10px]">
                          <thead className="sticky top-0 z-10 bg-surface-900">
                            <tr className="border-b border-surface-700 text-ink-muted">
                              {availableColumns.map((col) => (
                                <th key={col} className="whitespace-nowrap px-3 py-2">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-surface-800">
                            {previewRows.map((row, index) => (
                              <tr key={index} className="text-ink-muted">
                                {availableColumns.map((col) => (
                                  <td
                                    key={`${index}-${col}`}
                                    className="max-w-xs truncate px-3 py-2"
                                  >
                                    {row[col] ?? ''}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-ink-muted">
                  {t('samples.jsonlFile')}
                </label>
                <input
                  type="file"
                  accept=".jsonl,.json"
                  onChange={handleJsonlFileChange}
                  className="block w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink file:mr-3 file:rounded-md file:border-0 file:bg-surface-800 file:px-3 file:py-1 file:text-xs file:text-ink hover:file:bg-surface-700"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isImporting}
            className="inline-flex items-center justify-center rounded-md border border-surface-700 bg-surface-800 px-4 py-2 text-xs font-medium text-ink transition-colors hover:bg-surface-700 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!canImport}
            className="btn-primary px-4 py-2 text-xs disabled:opacity-50"
          >
            {isImporting && <Loader2 size={14} className="animate-spin" />}
            {t('samples.importButton')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-2 py-3 text-xs font-medium transition-colors ${
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

interface MappingGroupProps {
  title: string;
  children: React.ReactNode;
}

function MappingGroup({ title, children }: MappingGroupProps) {
  return (
    <div className="rounded-md border border-surface-800 bg-surface-950/50 p-3">
      <h4 className="mb-2 text-xs font-semibold text-ink-muted">{title}</h4>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}
