import { AlertTriangle, ScanSearch } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import type { BBoxFormat, BBoxParser, ImageSlotSpec } from '../../types';
import { BBoxFormatSpecDoc } from './BBoxFormatSpecDoc';

const PRESETS = [
  'qwen_inline',
  'gemini_inline',
  'bracket_prefix',
  'bracket_only',
  'xml_tag',
] as const;

const ORDERS = ['xyxy', 'yxyx', 'xywh', 'cxcywh'] as const;
const SPACES = ['normalized_1000', 'normalized_1'] as const;

const DEFAULT_PRESET = PRESETS[0];

const INPUT_CLS =
  'rounded-md border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none';

type CoordOrder = NonNullable<BBoxFormat['order']>;
type CoordSpace = NonNullable<BBoxFormat['space']>;

interface CustomDraft {
  pattern: string;
  coordGroups: number[];
  labelGroup: number | null;
  order: CoordOrder;
  space: CoordSpace;
}

const DEFAULT_CUSTOM_DRAFT: CustomDraft = {
  pattern: '',
  coordGroups: [1, 2, 3, 4],
  labelGroup: null,
  order: 'xyxy',
  space: 'normalized_1000',
};

interface BBoxParserConfigProps {
  /** Current value; null = bbox parsing disabled. */
  value: BBoxParser | null;
  imageSlots: ImageSlotSpec[];
  onChange: (value: BBoxParser | null) => void;
}

/**
 * Config form for OutputContract.bbox_parser.
 *
 * Emits backend-ready objects (snake_case). Preset and custom modes are
 * mutually exclusive — the inactive branch is stripped on emit (the backend
 * rejects payloads carrying both), but each branch's inputs are kept as
 * local drafts so toggling modes never loses what the user typed.
 */
export function BBoxParserConfig({ value, imageSlots, onChange }: BBoxParserConfigProps) {
  const { t } = useI18n();
  const enabled = value !== null;
  const mode: 'preset' | 'custom' = value?.pattern != null ? 'custom' : 'preset';

  // Drafts for the inactive mode, preserved across mode switches.
  const [presetDraft, setPresetDraft] = useState<string>(DEFAULT_PRESET);
  const [customDraft, setCustomDraft] = useState<CustomDraft>(DEFAULT_CUSTOM_DRAFT);

  const slotValid = value != null && imageSlots.some((s) => s.slot_id === value.image_slot);
  const fallbackSlot = imageSlots[0]?.slot_id ?? '';

  // Auto-repair a missing/stale image_slot (e.g. slot deleted after enabling)
  // so the emitted payload always references a real slot when one exists.
  useEffect(() => {
    if (value && !slotValid && fallbackSlot) {
      onChange({ ...value, image_slot: fallbackSlot });
    }
  }, [value, slotValid, fallbackSlot, onChange]);

  function handleToggle(checked: boolean) {
    if (!checked) {
      onChange(null);
      return;
    }
    onChange(buildPresetValue(fallbackSlot, presetDraft));
  }

  function handleModeSwitch(next: 'preset' | 'custom') {
    if (!value || next === mode) return;
    if (next === 'custom') {
      if (value.preset) setPresetDraft(value.preset);
      setCustomDraft(extractCustomDraft(value));
      onChange(buildCustomValue(value.image_slot, customDraft));
    } else {
      setCustomDraft(extractCustomDraft(value));
      onChange(buildPresetValue(value.image_slot, presetDraft));
    }
  }

  function updateSlot(slotId: string) {
    if (!value) return;
    onChange({ ...value, image_slot: slotId });
  }

  function updatePreset(preset: string) {
    if (!value) return;
    setPresetDraft(preset);
    onChange(buildPresetValue(value.image_slot, preset));
  }

  function updateCustom(patch: Partial<CustomDraft>) {
    if (!value) return;
    const next = { ...extractCustomDraft(value), ...patch };
    setCustomDraft(next);
    onChange(buildCustomValue(value.image_slot, next));
  }

  const custom = value && mode === 'custom' ? extractCustomDraft(value) : customDraft;
  const patternEmpty = mode === 'custom' && !custom.pattern.trim();
  const coordGroupsInvalid = mode === 'custom' && custom.coordGroups.length !== 4;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <ScanSearch size={12} />
          {t('prompt.bboxParser.title')}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => handleToggle(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-surface-600 bg-surface-800 text-accent focus:ring-accent"
          />
          {t('prompt.bboxParser.enable')}
        </label>
      </div>

      {enabled && value && (
        <div className="flex flex-col gap-2.5 rounded-md border border-surface-800 bg-surface-950/50 p-3">
          {imageSlots.length === 0 ? (
            <Warning text={t('prompt.bboxParser.noSlots')} />
          ) : (
            <Field label={t('prompt.bboxParser.imageSlot')}>
              <select
                value={slotValid ? value.image_slot : fallbackSlot}
                onChange={(event) => updateSlot(event.target.value)}
                className={INPUT_CLS}
              >
                {imageSlots.map((slot) => (
                  <option key={slot.slot_id} value={slot.slot_id}>
                    {slotLabel(slot)}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={t('prompt.bboxParser.mode')}>
            <div className="flex gap-0.5 rounded-md border border-surface-700 bg-surface-950 p-0.5">
              {(['preset', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleModeSwitch(m)}
                  className={[
                    'flex-1 rounded px-2 py-1 text-xs transition-colors',
                    mode === m
                      ? 'bg-accent/15 font-medium text-accent'
                      : 'text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {t(`prompt.bboxParser.mode.${m}`)}
                </button>
              ))}
            </div>
          </Field>

          {mode === 'preset' ? (
            <Field label={t('prompt.bboxParser.preset')}>
              <select
                value={value.preset ?? DEFAULT_PRESET}
                onChange={(event) => updatePreset(event.target.value)}
                className={INPUT_CLS}
              >
                {PRESETS.map((preset) => (
                  <option
                    key={preset}
                    value={preset}
                    title={t(`prompt.bboxParser.preset.${preset}`)}
                  >
                    {t(`prompt.bboxParser.preset.${preset}`)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Field label={t('prompt.bboxParser.pattern')}>
                <textarea
                  rows={1}
                  value={custom.pattern}
                  onChange={(event) => updateCustom({ pattern: event.target.value })}
                  placeholder={'region\\[(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\]\\s*[:：]\\s*(.+)'}
                  spellCheck={false}
                  className={`${INPUT_CLS} resize-y font-mono`}
                />
                {patternEmpty && <Warning text={t('prompt.bboxParser.warningEmptyPattern')} />}
              </Field>

              <Field label={t('prompt.bboxParser.coordGroups')}>
                <div className="grid grid-cols-4 gap-1.5">
                  {custom.coordGroups.map((group, index) => (
                    <input
                      key={index}
                      type="number"
                      min={1}
                      value={group}
                      onChange={(event) => {
                        const n = Number.parseInt(event.target.value, 10);
                        if (Number.isNaN(n)) return;
                        const next = [...custom.coordGroups];
                        next[index] = n;
                        updateCustom({ coordGroups: next });
                      }}
                      className={`${INPUT_CLS} text-center font-mono`}
                    />
                  ))}
                </div>
                {coordGroupsInvalid && (
                  <Warning text={t('prompt.bboxParser.warningCoordGroups')} />
                )}
              </Field>

              <div className="grid grid-cols-3 gap-2">
                <Field label={t('prompt.bboxParser.labelGroup')}>
                  <input
                    type="number"
                    min={1}
                    value={custom.labelGroup ?? ''}
                    placeholder="—"
                    onChange={(event) => {
                      const raw = event.target.value;
                      const n = Number.parseInt(raw, 10);
                      updateCustom({
                        labelGroup: raw === '' || Number.isNaN(n) ? null : Math.max(1, n),
                      });
                    }}
                    className={`${INPUT_CLS} font-mono`}
                  />
                </Field>
                <Field label={t('prompt.bboxParser.order')}>
                  <select
                    value={custom.order}
                    onChange={(event) =>
                      updateCustom({ order: event.target.value as CoordOrder })
                    }
                    className={INPUT_CLS}
                  >
                    {ORDERS.map((order) => (
                      <option key={order} value={order}>
                        {t(`prompt.bboxParser.order.${order}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('prompt.bboxParser.space')}>
                  <select
                    value={custom.space}
                    onChange={(event) =>
                      updateCustom({ space: event.target.value as CoordSpace })
                    }
                    className={INPUT_CLS}
                  >
                    {SPACES.map((space) => (
                      <option key={space} value={space}>
                        {t(`prompt.bboxParser.space.${space}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <BBoxFormatSpecDoc
                pattern={custom.pattern}
                coordGroups={custom.coordGroups}
                labelGroup={custom.labelGroup}
                order={custom.order}
                space={custom.space}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-ink-dim">{label}</label>
      {children}
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-amber-400">
      <AlertTriangle size={10} />
      {text}
    </div>
  );
}

function slotLabel(slot: ImageSlotSpec): string {
  return slot.label?.trim() || slot.role_hint?.trim() || slot.slot_id;
}

/** Preset-mode payload: custom branch stripped (backend rejects both set). */
function buildPresetValue(imageSlot: string, preset: string): BBoxParser {
  return {
    image_slot: imageSlot,
    preset,
    pattern: null,
    coord_groups: null,
    label_group: null,
  };
}

/** Custom-mode payload: preset stripped; format only applies here. */
function buildCustomValue(imageSlot: string, draft: CustomDraft): BBoxParser {
  return {
    image_slot: imageSlot,
    preset: null,
    pattern: draft.pattern,
    coord_groups: draft.coordGroups,
    label_group: draft.labelGroup,
    format: { order: draft.order, space: draft.space },
  };
}

function extractCustomDraft(value: BBoxParser): CustomDraft {
  return {
    pattern: typeof value.pattern === 'string' ? value.pattern : '',
    coordGroups:
      Array.isArray(value.coord_groups) && value.coord_groups.length === 4
        ? [...value.coord_groups]
        : [...DEFAULT_CUSTOM_DRAFT.coordGroups],
    labelGroup: typeof value.label_group === 'number' ? value.label_group : null,
    order: value.format?.order ?? DEFAULT_CUSTOM_DRAFT.order,
    space: value.format?.space ?? DEFAULT_CUSTOM_DRAFT.space,
  };
}
