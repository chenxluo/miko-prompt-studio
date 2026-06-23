import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileText,
  HelpCircle,
  ImageIcon,
  Plus,
  ScanLine,
  Settings,
  Terminal,
  Trash2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import * as api from '../../api/client';
import { useI18n } from '../../i18n';
import { type ImageSlot } from '../../store/labStore';
import { useLabStore } from '../../store/labStore';
import type { ImageRef, ImageSlotSpec, OutputContract, OutputMode, VariableSpec } from '../../types';
import { resolveImageSrc } from './ImagePanel';

const VARIABLE_RE = /\{\{\s*#?\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g;

export function PromptPanel() {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  const skipNextSyncRef = useRef(false);
  const draggingSlotIndexRef = useRef<number | null>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const imagePickerRef = useRef<HTMLDivElement>(null);

  const systemPrompt = useLabStore((state) => state.systemPrompt);
  const userPrompt = useLabStore((state) => state.userPrompt);
  const outputContract = useLabStore((state) => state.outputContract);
  const images = useLabStore((state) => state.images);
  const imageSlots = useLabStore((state) => state.imageSlots);
  const templateImageSlotSpecs = useLabStore((state) => state.templateImageSlotSpecs);
  const templateVariableSpecs = useLabStore((state) => state.templateVariableSpecs);
  const variables = useLabStore((state) => state.variables);

  const setSystemPrompt = useLabStore((state) => state.setSystemPrompt);
  const setUserPrompt = useLabStore((state) => state.setUserPrompt);
  const setOutputMode = useLabStore((state) => state.setOutputMode);
  const setOutputContract = useLabStore((state) => state.setOutputContract);
  const addImageSlot = useLabStore((state) => state.addImageSlot);
  const removeImageSlot = useLabStore((state) => state.removeImageSlot);
  const setImageSlots = useLabStore((state) => state.setImageSlots);
  const setVariable = useLabStore((state) => state.setVariable);
  const setTemplateVariableSpecs = useLabStore((state) => state.setTemplateVariableSpecs);

  const [jsonError, setJsonError] = useState<string | null>(null);
  const [conditionalName, setConditionalName] = useState('');
  const [varPickerOpen, setVarPickerOpen] = useState(false);
  const [syntaxHelpOpen, setSyntaxHelpOpen] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (imagePickerRef.current && !imagePickerRef.current.contains(event.target as Node)) {
        setImagePickerOpen(false);
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setImagePickerOpen(false);
    }
    if (imagePickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEsc);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [imagePickerOpen]);

  // Sync the editor with external state (load task, image removal, etc.).
  // Skip the sync immediately after an input event so the browser keeps caret
  // control and normalized whitespace is not overwritten.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }

    const nextHtml = buildEditorHtml(userPrompt, imageSlots, images, t);
    if (editor.innerHTML !== nextHtml) {
      editor.innerHTML = nextHtml;
    }
  }, [userPrompt, imageSlots, images, t]);

  const outputModes = useMemo<{ value: OutputMode; label: string }[]>(
    () => [
      { value: 'free_text', label: t('prompt.mode.freeText') },
      { value: 'soft_sections', label: t('prompt.mode.softSections') },
      { value: 'loose_json', label: t('prompt.mode.looseJson') },
      { value: 'strict_json', label: t('prompt.mode.strictJson') },
      { value: 'custom', label: t('prompt.mode.custom') },
    ],
    [t],
  );

  const sectionNames = useMemo(
    () => extractSectionNames(outputContract),
    [outputContract],
  );

  const jsonSchemaString = useMemo(() => {
    if (!outputContract.json_schema) return '';
    try {
      return JSON.stringify(outputContract.json_schema, null, 2);
    } catch {
      return '';
    }
  }, [outputContract.json_schema]);

  const serialize = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const { text, slots } = serializeEditor(editor);
    setUserPrompt(text);
    setImageSlots(slots);
  }, [setUserPrompt, setImageSlots]);

  const handleInput = useCallback(() => {
    skipNextSyncRef.current = true;
    serialize();
  }, [serialize]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;

      const editor = editorRef.current;
      if (!editor) return;

      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        // Paste at the end if the editor is not focused.
        editor.focus();
        const endRange = document.createRange();
        endRange.selectNodeContents(editor);
        endRange.collapse(false);
        selection.removeAllRanges();
        selection.addRange(endRange);
      }

      const activeRange = selection.getRangeAt(0);
      activeRange.deleteContents();
      const node = document.createTextNode(text);
      activeRange.insertNode(node);
      activeRange.setStartAfter(node);
      activeRange.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(activeRange);

      skipNextSyncRef.current = true;
      serialize();
    },
    [serialize],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();

      const editor = editorRef.current;
      if (!editor) return;
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode('\n');
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);

      skipNextSyncRef.current = true;
      serialize();
    },
    [serialize],
  );

  const handleInsertImage = useCallback(
    (imageIndex: number) => {
      const editor = editorRef.current;
      if (!editor) return;

      editor.focus();
      const selection = window.getSelection();
      let position = userPrompt.length;

      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (editor.contains(range.commonAncestorContainer)) {
          position = getTextPosition(editor, range.startContainer, range.startOffset);
        }
      }

      addImageSlot(imageIndex, position);

      // Place caret after the newly inserted chip once the store re-renders it.
      requestAnimationFrame(() => {
        const chip = editor.querySelector<HTMLElement>(`[data-image-index="${imageIndex}"]`);
        if (chip) setCaretAfterNode(chip);
      });
    },
    [addImageSlot, userPrompt.length],
  );

  const handleEditorClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-chip]');
      if (!button) return;

      const imageIndex = parseInt(button.dataset.imageIndex ?? '', 10);
      if (Number.isNaN(imageIndex)) return;

      event.preventDefault();
      event.stopPropagation();
      removeImageSlot(imageIndex);
    },
    [removeImageSlot],
  );

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-remove-chip]')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-remove-chip]')) {
      event.preventDefault();
      return;
    }

    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-slot-index]');
    if (!chip) {
      event.preventDefault();
      return;
    }

    const slotIndex = parseInt(chip.dataset.slotIndex ?? '', 10);
    if (Number.isNaN(slotIndex)) {
      event.preventDefault();
      return;
    }

    draggingSlotIndexRef.current = slotIndex;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(slotIndex));
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceIndex = draggingSlotIndexRef.current;
      draggingSlotIndexRef.current = null;

      if (sourceIndex == null) return;

      const targetIndex = findDropSlotIndex(event);
      if (targetIndex == null || targetIndex === sourceIndex) return;

      setImageSlots(reorderSlots(imageSlots, sourceIndex, targetIndex));
    },
    [imageSlots, setImageSlots],
  );

  const handleDragEnd = useCallback(() => {
    draggingSlotIndexRef.current = null;
  }, []);

  function findDropSlotIndex(event: DragEvent<HTMLDivElement>): number | null {
    const elements = document.elementsFromPoint(event.clientX, event.clientY);
    for (const element of elements) {
      const chip = element.closest<HTMLElement>('[data-slot-index]');
      if (chip) {
        const index = parseInt(chip.dataset.slotIndex ?? '', 10);
        if (!Number.isNaN(index)) return index;
      }
    }
    return null;
  }

  function reorderSlots(
    slots: ImageSlot[],
    sourceIndex: number,
    targetIndex: number,
  ): ImageSlot[] {
    const positions = [...slots]
      .sort((a, b) => a.position - b.position)
      .map((slot) => slot.position);
    const next = [...slots];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next.map((slot, index) => ({
      ...slot,
      position: positions[index] ?? slot.position,
    }));
  }

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const modeValue = event.target.value as OutputMode;
      setOutputMode(modeValue);
    },
    [setOutputMode],
  );

  const handleSectionNamesChange = useCallback(
    (value: string) => {
      const sections = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const parser =
        sections.length > 0
          ? { type: 'sections', options: { sections } }
          : null;
      setOutputContract({
        ...outputContract,
        parser,
      });
    },
    [outputContract, setOutputContract],
  );

  const handleJsonSchemaChange = useCallback(
    (value: string) => {
      if (!value.trim()) {
        setJsonError(null);
        setOutputContract({
          ...outputContract,
          json_schema: null,
        });
        return;
      }
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        setJsonError(null);
        setOutputContract({
          ...outputContract,
          json_schema: parsed,
        });
      } catch {
        setJsonError(t('prompt.invalidJsonSchema'));
      }
    },
    [outputContract, setOutputContract, t],
  );

  const [prompts, setPrompts] = useState<api.PromptListItem[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const loadPrompt = useLabStore((state) => state.loadPrompt);

  useEffect(() => {
    let cancelled = false;
    setPromptsLoading(true);
    api
      .listPrompts()
      .then((items) => {
        if (!cancelled) setPrompts(items);
      })
      .catch(() => {
        // Ignore: this is a convenience dropdown, not critical.
      })
      .finally(() => {
        if (!cancelled) setPromptsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectPrompt = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const promptId = event.target.value;
      if (!promptId) return;
      const prompt = prompts.find((p) => p.prompt_id === promptId);
      if (prompt) loadPrompt(prompt);
    },
    [prompts, loadPrompt],
  );

  function scanVariableIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(VARIABLE_RE)) {
      const id = match[1];
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  function mergeVariableSpecs(ids: string[], current: VariableSpec[]): VariableSpec[] {
    const map = new Map(current.map((spec) => [spec.var_id, spec]));
    const merged: VariableSpec[] = [];
    for (const id of ids) {
      const existing = map.get(id);
      if (existing) {
        merged.push(existing);
      } else {
        merged.push({
          var_id: id,
          label: '',
          description: '',
          required: false,
          default_value: null,
          type: 'string',
        });
      }
    }
    return merged;
  }

  function handleScanVariables() {
    const ids = scanVariableIds(`${systemPrompt}\n${userPrompt}`);
    setTemplateVariableSpecs(mergeVariableSpecs(ids, templateVariableSpecs));
  }

  function handleAddVariable() {
    setTemplateVariableSpecs([
      ...templateVariableSpecs,
      {
        var_id: `var_${Date.now()}`,
        label: '',
        description: '',
        required: false,
        default_value: null,
        type: 'string',
      },
    ]);
  }

  function handleUpdateVariable(index: number, patch: Partial<VariableSpec>) {
    const oldSpec = templateVariableSpecs[index];
    setTemplateVariableSpecs(
      templateVariableSpecs.map((spec, i) => (i === index ? { ...spec, ...patch } : spec)),
    );
    // If var_id changed, migrate the variable value to the new key
    if (patch.var_id && patch.var_id !== oldSpec?.var_id) {
      const oldKey = oldSpec.var_id;
      const newKey = patch.var_id;
      const currentValues = useLabStore.getState().variables;
      if (oldKey in currentValues) {
        const { [oldKey]: _old, ...rest } = currentValues;
        void _old;
        useLabStore.getState().setVariables({ ...rest, [newKey]: currentValues[oldKey] });
      }
    }
  }

  function handleDeleteVariable(index: number) {
    setTemplateVariableSpecs(templateVariableSpecs.filter((_, i) => i !== index));
  }

  function handleMoveVariable(index: number, direction: -1 | 1) {
    const next = [...templateVariableSpecs];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setTemplateVariableSpecs(next);
  }

  function handleInsertConditional() {
    const name = conditionalName.trim();
    if (!name) {
      editorRef.current?.focus();
      return;
    }

    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      const endRange = document.createRange();
      endRange.selectNodeContents(editor);
      endRange.collapse(false);
      selection.removeAllRanges();
      selection.addRange(endRange);
    }

    const activeRange = selection.getRangeAt(0);
    const selectedText = activeRange.toString();
    activeRange.deleteContents();

    const open = `{{#vars.${name}}}`;
    const close = `{{/vars.${name}}}`;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(open));
    if (selectedText) {
      fragment.appendChild(document.createTextNode(selectedText));
    }
    fragment.appendChild(document.createTextNode(close));

    activeRange.insertNode(fragment);

    const lastInserted = fragment.lastChild;
    if (lastInserted) {
      const newRange = document.createRange();
      newRange.setStartAfter(lastInserted);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    skipNextSyncRef.current = true;
    serialize();
  }

  function handleInsertVariable(varId: string) {
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      const endRange = document.createRange();
      endRange.selectNodeContents(editor);
      endRange.collapse(false);
      selection.removeAllRanges();
      selection.addRange(endRange);
    }

    const activeRange = selection.getRangeAt(0);
    const text = `{{vars.${varId}}}`;
    const textNode = document.createTextNode(text);
    activeRange.deleteContents();
    activeRange.insertNode(textNode);

    const newRange = document.createRange();
    newRange.setStartAfter(textNode);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);

    skipNextSyncRef.current = true;
    serialize();
    setVarPickerOpen(false);
  }

  return (
    <section className="panel flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{t('prompt.title')}</span>
        </div>
        <div className="relative">
          <select
            value=""
            onChange={handleSelectPrompt}
            disabled={promptsLoading}
            className="appearance-none rounded-md border border-surface-700 bg-surface-950 py-1.5 pl-3 pr-8 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
          >
            <option value="">{t('prompt.selectPrompt')}</option>
            {prompts.map((prompt) => (
              <option key={prompt.prompt_id} value={prompt.prompt_id}>
                {prompt.name}
              </option>
            ))}
          </select>
          <ChevronDown
            size={12}
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-dim"
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
              <Terminal size={12} />
              {t('prompt.systemPrompt')}
            </label>
            <span className="text-[10px] text-ink-dim">{t('prompt.systemPromptHint')}</span>
          </div>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={6}
            className="min-h-[8rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
              <Terminal size={12} />
              {t('prompt.userPrompt')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={conditionalName}
                onChange={(event) => setConditionalName(event.target.value)}
                placeholder={t('prompt.conditionalVarName')}
                className="w-28 rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={handleInsertConditional}
                className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1.5 text-xs text-ink-muted hover:bg-surface-800"
                title={t('prompt.insertConditional')}
              >
                <Braces size={12} />
                {t('prompt.insertConditional')}
              </button>
              {/* Variable quick-insert dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setVarPickerOpen((v) => !v)}
                  disabled={templateVariableSpecs.length === 0}
                  className={[
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                    templateVariableSpecs.length === 0
                      ? 'cursor-not-allowed border-surface-800 bg-surface-900 text-ink-dim'
                      : varPickerOpen
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-surface-700 bg-surface-950 text-ink hover:border-surface-600 hover:text-ink',
                  ].join(' ')}
                  title={t('prompt.insertVariable')}
                >
                  <Braces size={12} />
                  {t('prompt.insertVariable')}
                </button>
                {varPickerOpen && templateVariableSpecs.length > 0 && (
                  <div className="absolute right-0 top-full z-10 mt-2 max-h-64 w-56 overflow-auto rounded-md border border-surface-700 bg-surface-900 p-1 shadow-panel animate-fade-in">
                    {templateVariableSpecs.map((spec) => (
                      <button
                        key={spec.var_id}
                        type="button"
                        onClick={() => {
                          handleInsertVariable(spec.var_id);
                          setVarPickerOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-800"
                      >
                        <span className="font-mono text-ink-muted">{`{{vars.${spec.var_id}}}`}</span>
                        <span className="truncate text-ink-dim">{spec.label || spec.var_id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Syntax help */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSyntaxHelpOpen((v) => !v)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-surface-700 bg-surface-950 text-ink-dim hover:text-ink"
                  title={t('prompt.syntaxHelp')}
                >
                  <HelpCircle size={14} />
                </button>
                {syntaxHelpOpen && (
                  <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-md border border-surface-700 bg-surface-900 p-3 shadow-panel animate-fade-in">
                    <div className="space-y-2 text-xs text-ink-muted">
                      <div>
                        <code className="text-accent">{`{{vars.x}}`}</code>
                        <p className="mt-0.5 text-ink-dim">{t('prompt.syntaxVar')}</p>
                      </div>
                      <div>
                        <code className="text-accent">{`{{#vars.x}}...{{/vars.x}}`}</code>
                        <p className="mt-0.5 text-ink-dim">{t('prompt.syntaxConditionalIf')}</p>
                      </div>
                      <div>
                        <code className="text-accent">{`{{^vars.x}}...{{/vars.x}}`}</code>
                        <p className="mt-0.5 text-ink-dim">{t('prompt.syntaxConditionalUnless')}</p>
                      </div>
                      <div>
                        <code className="text-accent">{`{{sample.x}}`}</code>
                        <p className="mt-0.5 text-ink-dim">{t('prompt.syntaxSample')}</p>
                      </div>
                      <div>
                        <code className="text-accent">{`{{metadata.x}}`}</code>
                        <p className="mt-0.5 text-ink-dim">{t('prompt.syntaxMetadata')}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div ref={imagePickerRef} className="relative">
                <button
                  type="button"
                  onClick={() => images.length > 0 && setImagePickerOpen((v) => !v)}
                  disabled={images.length === 0}
                  aria-expanded={imagePickerOpen}
                  className={[
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                    images.length === 0
                      ? 'cursor-not-allowed border-surface-800 bg-surface-900 text-ink-dim'
                      : imagePickerOpen
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-surface-700 bg-surface-950 text-ink hover:border-surface-600 hover:text-ink',
                  ].join(' ')}
                  title={t('prompt.insertImage')}
                >
                  <ImageIcon size={12} />
                  <span className="max-w-[8rem] truncate sm:max-w-[12rem]">
                    {images.length === 0
                      ? `${t('prompt.insertImage')} — ${t('prompt.noImages')}`
                      : t('prompt.insertImage')}
                  </span>
                </button>
                {images.length > 0 && imagePickerOpen && (
                  <div className="absolute right-0 top-full z-10 mt-2 max-h-80 w-64 overflow-auto rounded-md border border-surface-700 bg-surface-900 p-2 shadow-panel animate-fade-in">
                    <ImagePickerBySlot
                      images={images}
                      specs={templateImageSlotSpecs}
                      onSelect={(index) => {
                        handleInsertImage(index);
                        setImagePickerOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            ref={editorRef}
            contentEditable
            role="textbox"
            aria-multiline="true"
            data-placeholder={t('prompt.empty')}
            onInput={handleInput}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onClick={handleEditorClick}
            onMouseDown={handleMouseDown}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            className="rich-prompt-editor min-h-[6rem] resize-y overflow-auto whitespace-pre-wrap rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          />

          <p className="text-xs text-ink-dim">{t('prompt.imageRefHint')}</p>
        </div>

        <UnifiedVariableEditor
          specs={templateVariableSpecs}
          values={variables}
          onScan={handleScanVariables}
          onAdd={handleAddVariable}
          onUpdate={handleUpdateVariable}
          onDelete={handleDeleteVariable}
          onMove={handleMoveVariable}
          onValueChange={setVariable}
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted">
            {t('prompt.outputContractMode')}
          </label>
          <select
            value={outputContract.mode ?? 'free_text'}
            onChange={handleModeChange}
            className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
          >
            {outputModes.map((modeItem) => (
              <option key={modeItem.value} value={modeItem.value}>
                {modeItem.label}
              </option>
            ))}
          </select>
        </div>

        {outputContract.mode === 'soft_sections' && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted">
              {t('prompt.sectionNames')}
            </label>
            <input
              type="text"
              value={sectionNames}
              onChange={(event) => handleSectionNamesChange(event.target.value)}
              placeholder={t('prompt.sectionNamesPlaceholder')}
              className="rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
          </div>
        )}

        {(outputContract.mode === 'loose_json' ||
          outputContract.mode === 'strict_json') && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted">
              {t('prompt.jsonSchema')}
            </label>
            <textarea
              defaultValue={jsonSchemaString}
              onChange={(event) => handleJsonSchemaChange(event.target.value)}
              rows={6}
              className="min-h-[6rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
            />
            {jsonError && (
              <p className="text-xs text-danger">{jsonError}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ImagePickerBySlot({
  images,
  specs,
  onSelect,
}: {
  images: ImageRef[];
  specs: ImageSlotSpec[];
  onSelect: (imageIndex: number) => void;
}) {
  const { t } = useI18n();

  const bySlot = useMemo(() => {
    const groups = new Map<string | undefined, { spec?: ImageSlotSpec; images: { image: ImageRef; index: number }[] }>();
    for (const spec of specs) {
      groups.set(spec.slot_id, { spec, images: [] });
    }
    images.forEach((image, index) => {
      const group = groups.get(image.slot_id);
      if (group) {
        group.images.push({ image, index });
      } else {
        groups.set(image.slot_id, { images: [{ image, index }] });
      }
    });
    return groups;
  }, [images, specs]);

  function slotTitle(spec?: ImageSlotSpec): string {
    if (!spec) return t('image.unslotted');
    return spec.label?.trim() || spec.role_hint?.trim() || t('image.unnamedSlot');
  }

  return (
    <div className="space-y-3">
      {Array.from(bySlot.entries()).map(([slotId, group]) => (
        <div key={slotId ?? 'unslotted'} className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="truncate text-[10px] font-medium text-accent">{slotTitle(group.spec)}</span>
            <span className="text-[10px] text-ink-dim">{group.images.length}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {group.images.map(({ image, index }) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className="flex flex-col items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-surface-800"
                title={image.display_name ?? image.role ?? t('image.fallback', { n: index + 1 })}
              >
                <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-surface-950"
                >
                  <img
                    src={resolveImageSrc(image)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function buildEditorHtml(
  text: string,
  slots: ImageSlot[],
  images: ImageRef[],
  t: ReturnType<typeof useI18n>['t'],
): string {
  let html = '';
  let last = 0;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const position = Math.max(last, Math.min(slot.position, text.length));
    html += escapeHtml(text.slice(last, position));
    html += renderChip(slot, i, images, t);
    last = position;
  }

  html += escapeHtml(text.slice(last));
  return html;
}

function renderChip(
  slot: ImageSlot,
  slotIndex: number,
  images: ImageRef[],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const image = images[slot.imageIndex];
  const src = image ? resolveImageSrc(image) : '';
  const role = image?.role?.trim();
  const title = role ?? image?.display_name ?? t('image.fallback', { n: slot.imageIndex + 1 });

  const imageIconSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
  const closeSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  return `<span contenteditable="false" draggable="true" data-slot-index="${slotIndex}" data-image-index="${slot.imageIndex}" class="inline-flex h-12 items-center gap-1 align-middle rounded-md border border-accent/30 bg-accent/10 px-1 text-accent select-none cursor-grab active:cursor-grabbing" title="${escapeHtml(title)}">${src ? `<img src="${src}" alt="" class="h-full w-12 rounded object-cover" draggable="false" />` : `<span class="flex h-full w-12 items-center justify-center rounded bg-surface-950">${imageIconSvg}</span>`}${role ? `<span class="max-w-[6rem] truncate text-[11px]">${escapeHtml(role)}</span>` : ''}<button type="button" data-remove-chip data-image-index="${slot.imageIndex}" class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-accent transition-colors hover:bg-accent/20 hover:text-ink" aria-label="${t('image.remove')}" draggable="false">${closeSvg}</button></span>`;
}

function serializeEditor(editor: HTMLElement): { text: string; slots: ImageSlot[] } {
  const slots: ImageSlot[] = [];
  let text = '';

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.dataset.imageIndex != null) {
        slots.push({
          imageIndex: parseInt(element.dataset.imageIndex, 10),
          position: text.length,
        });
        return;
      }

      // Skip placeholder nodes.
      if (element.classList.contains('pointer-events-none')) {
        return;
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }
  }

  walk(editor);

  // If everything is empty, clear the editor so the placeholder shows.
  if (text === '' && slots.length === 0 && editor.innerHTML !== '') {
    editor.innerHTML = '';
  }

  return { text, slots };
}

function getTextPosition(root: Node, node: Node, offset: number): number {
  let position = 0;
  let done = false;

  function walk(current: Node): boolean {
    if (done) return true;

    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        position += (current.textContent ?? '').slice(0, offset).length;
      }
      done = true;
      return true;
    }

    if (current.nodeType === Node.TEXT_NODE) {
      position += (current.textContent ?? '').length;
      return false;
    }

    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as HTMLElement;
      if (element.dataset.imageIndex != null) {
        return false;
      }
      if (element.classList.contains('pointer-events-none')) {
        return false;
      }
      for (const child of Array.from(current.childNodes)) {
        if (walk(child)) return true;
      }
    }

    return false;
  }

  walk(root);
  return position;
}

function setCaretAfterNode(node: Node) {
  const selection = window.getSelection();
  if (!selection) return;

  const parent = node.parentNode;
  const next = node.nextSibling;
  let textNode: Text;

  if (next && next.nodeType === Node.TEXT_NODE) {
    textNode = next as Text;
  } else {
    textNode = document.createTextNode('');
    parent?.insertBefore(textNode, next);
  }

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}

function extractSectionNames(contract: OutputContract): string {
  const parser = contract.parser;
  if (!parser || parser.type !== 'sections') return '';
  const sections = parser.options?.sections;
  if (Array.isArray(sections)) {
    return sections
      .filter((section): section is string => typeof section === 'string')
      .join(', ');
  }
  return '';
}

interface UnifiedVariableEditorProps {
  specs: VariableSpec[];
  values: Record<string, string>;
  onScan: () => void;
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<VariableSpec>) => void;
  onDelete: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onValueChange: (varId: string, value: string) => void;
}

function UnifiedVariableEditor({
  specs,
  values,
  onScan,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onValueChange,
}: UnifiedVariableEditorProps) {
  const { t } = useI18n();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink-muted">
          {t('prompt.variableSpecs')}
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onScan}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
          >
            <ScanLine size={12} />
            {t('prompt.scanVariables')}
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 px-2 py-1 text-xs text-ink-muted hover:bg-surface-800"
          >
            <Plus size={12} />
            {t('prompt.addVariable')}
          </button>
        </div>
      </div>

      {specs.length === 0 ? (
        <div className="rounded-md border border-dashed border-surface-700 p-4 text-center text-xs text-ink-dim">
          {t('prompt.noVariables')}
        </div>
      ) : (
        <div className="space-y-2">
          {specs.map((spec, index) => {
            const isExpanded = expandedIndex === index;
            const value = values[spec.var_id] ?? '';
            return (
              <div
                key={index}
                className="rounded-md border border-surface-700 bg-surface-950 p-3"
              >
                {/* Main row: var_id + value input + actions */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={spec.var_id}
                    onChange={(event) => onUpdate(index, { var_id: event.target.value })}
                    placeholder={t('prompt.variableId')}
                    className="w-28 shrink-0 rounded-md border border-surface-700 bg-surface-900 px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                  />
                  {spec.required ? (
                    <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                      {t('prompt.required')}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded bg-surface-800 px-1.5 py-0.5 text-[10px] text-ink-muted">
                      {t('prompt.optional')}
                    </span>
                  )}
                  <input
                    type="text"
                    value={value}
                    onChange={(event) => onValueChange(spec.var_id, event.target.value)}
                    placeholder={spec.default_value ?? t('prompt.variableDefaultValueNone')}
                    className="min-w-0 flex-1 rounded-md border border-surface-700 bg-surface-950 px-3 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setExpandedIndex(isExpanded ? null : index)}
                    className={[
                      'shrink-0 rounded p-1.5 transition-colors',
                      isExpanded
                        ? 'bg-accent/10 text-accent'
                        : 'text-ink-dim hover:bg-surface-800 hover:text-ink',
                    ].join(' ')}
                    aria-label={t('prompt.variableSettings')}
                  >
                    <Settings size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(index)}
                    className="shrink-0 rounded p-1.5 text-ink-dim hover:bg-danger/10 hover:text-danger"
                    aria-label={t('prompt.deleteVariable')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Expanded settings */}
                {isExpanded && (
                  <div className="mt-3 space-y-3 border-t border-surface-800 pt-3">
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        value={spec.label ?? ''}
                        onChange={(event) => onUpdate(index, { label: event.target.value })}
                        placeholder={t('prompt.variableLabel')}
                        className="rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                      <input
                        type="text"
                        value={spec.description ?? ''}
                        onChange={(event) => onUpdate(index, { description: event.target.value })}
                        placeholder={t('prompt.variableDescription')}
                        className="rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={spec.required ?? false}
                          onChange={(event) => onUpdate(index, { required: event.target.checked })}
                          className="rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
                        />
                        {t('prompt.required')}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        {t('prompt.variableDefaultValue')}
                        <input
                          type="text"
                          value={spec.default_value ?? ''}
                          onChange={(event) =>
                            onUpdate(index, {
                              default_value: event.target.value === '' ? null : event.target.value,
                            })
                          }
                          placeholder={t('prompt.variableDefaultValueNone')}
                          className="w-32 rounded-md border border-surface-700 bg-surface-900 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
                        />
                      </label>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onMove(index, -1)}
                          disabled={index === 0}
                          className="rounded p-1 text-ink-dim hover:bg-surface-800 disabled:opacity-30"
                          aria-label={t('prompt.moveUp')}
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onMove(index, 1)}
                          disabled={index === specs.length - 1}
                          className="rounded p-1 text-ink-dim hover:bg-surface-800 disabled:opacity-30"
                          aria-label={t('prompt.moveDown')}
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
