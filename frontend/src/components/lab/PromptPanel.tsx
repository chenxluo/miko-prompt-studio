import {
  FileText,
  ImageIcon,
  Terminal,
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

import { useI18n } from '../../i18n';
import { type ImageSlot } from '../../store/labStore';
import { useLabStore } from '../../store/labStore';
import type { ImageRef, OutputContract, OutputMode } from '../../types';
import { resolveImageSrc } from './ImagePanel';

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

  const setSystemPrompt = useLabStore((state) => state.setSystemPrompt);
  const setUserPrompt = useLabStore((state) => state.setUserPrompt);
  const setOutputMode = useLabStore((state) => state.setOutputMode);
  const setOutputContract = useLabStore((state) => state.setOutputContract);
  const addImageSlot = useLabStore((state) => state.addImageSlot);
  const removeImageSlot = useLabStore((state) => state.removeImageSlot);
  const setImageSlots = useLabStore((state) => state.setImageSlots);

  const [jsonError, setJsonError] = useState<string | null>(null);

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

  return (
    <section className="panel flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-800 px-4 py-3">
        <FileText size={16} className="text-accent" />
        <span className="text-sm font-semibold text-ink">{t('prompt.title')}</span>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
            <Terminal size={12} />
            {t('prompt.systemPrompt')}
          </label>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={4}
            className="min-h-[5rem] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
              <Terminal size={12} />
              {t('prompt.userPrompt')}
            </label>
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
                <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-surface-700 bg-surface-900 p-2 shadow-panel animate-fade-in">
                  <div className="grid grid-cols-3 gap-2">
                    {images.map((image, index) => (
                      <button
                        key={index}
                        type="button"
                        onClick={() => {
                          handleInsertImage(index);
                          setImagePickerOpen(false);
                        }}
                        className="flex flex-col items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-surface-800"
                        title={image.display_name ?? t('image.fallback', { n: index + 1 })}
                      >
                        <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-surface-950">
                          <img
                            src={resolveImageSrc(image)}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </span>
                        <span className="w-full truncate text-center text-[10px] text-ink-dim">
                          {image.display_name ?? t('image.fallback', { n: index + 1 })}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
  const title = image?.display_name ?? t('image.fallback', { n: slot.imageIndex + 1 });

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
