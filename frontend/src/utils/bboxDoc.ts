import type { I18n } from '../i18n';
import type { BBoxFormat } from '../types';

export interface FormatSpecInput {
  pattern: string;
  coordGroups: number[];
  labelGroup: number | null;
  order: NonNullable<BBoxFormat['order']>;
  space: NonNullable<BBoxFormat['space']>;
}

const SAMPLE_NUMBERS = ['100', '200', '500', '800'];
const SAMPLE_LABEL_ZH = '描述文字';

/**
 * Build a self-contained prompt fragment that tells the model how to emit
 * bounding boxes, derived from the current custom parser config. The doc is
 * localized with the UI locale (users paste it into their own prompts).
 */
export function buildFormatSpecDoc(input: FormatSpecInput, t: I18n['t']): string {
  const [g1, g2, g3, g4] = [0, 1, 2, 3].map((i) =>
    typeof input.coordGroups[i] === 'number' ? String(input.coordGroups[i]) : '?',
  );

  const example = generateExampleFromPattern(input.pattern);

  const lines: string[] = [
    t('prompt.bboxParser.docs.intro'),
    '',
    `${t('prompt.bboxParser.docs.formatSpec')}:`,
    `- ${t('prompt.bboxParser.docs.coordOrder')}: ${t(`prompt.bboxParser.docs.order.${input.order}`)}`,
    `- ${t('prompt.bboxParser.docs.coordRange')}: ${t(`prompt.bboxParser.docs.space.${input.space}`)}`,
    `- ${t('prompt.bboxParser.docs.regexLabel')}`,
    input.pattern,
    '',
    `${t('prompt.bboxParser.docs.fieldDesc')}:`,
    `- ${t('prompt.bboxParser.docs.coordGroupsLine', { g1, g2, g3, g4 })}`,
  ];

  if (input.labelGroup != null) {
    lines.push(`- ${t('prompt.bboxParser.docs.labelFieldLine', { g: input.labelGroup })}`);
  }

  lines.push(
    '',
    t('prompt.bboxParser.docs.example'),
    example ?? t('prompt.bboxParser.docs.exampleFallback'),
  );

  return lines.join('\n');
}

/**
 * Heuristically turn a regex pattern into a concrete example string.
 *
 * Strategy: replace well-known capture-group shapes ((\d+), (.+), ([^\n]+))
 * with sample values, collapse \s* / \s+ to a single space, resolve simple
 * character classes like [,，] to their first char, and unescape literals.
 * Anything left that still looks like regex syntax means we can't produce a
 * trustworthy example → return null so the UI shows a fallback note.
 */
export function generateExampleFromPattern(pattern: string): string | null {
  if (!pattern.trim()) return null;

  try {
    let example = pattern.trim();

    // Strip ^ / $ anchors.
    example = example.replace(/^\^+/, '').replace(/\$+$/, '');

    // Capture groups: numbers first (cycled so the four coords are distinct).
    let numIndex = 0;
    example = example.replace(
      /\(\\d\+\??\)/g,
      () => SAMPLE_NUMBERS[numIndex++ % SAMPLE_NUMBERS.length],
    );
    // Capture groups: generic text.
    example = example.replace(/\(\.\+\??\)/g, SAMPLE_LABEL_ZH);
    example = example.replace(/\(\.\*\??\)/g, SAMPLE_LABEL_ZH);
    example = example.replace(/\(\[\^\\n\][*+]\??\)/g, SAMPLE_LABEL_ZH);

    // Same shapes outside groups.
    example = example.replace(/\\d\+/g, () => SAMPLE_NUMBERS[numIndex++ % SAMPLE_NUMBERS.length]);
    example = example.replace(/\[\^\\n\][*+]/g, SAMPLE_LABEL_ZH);

    // Whitespace tokens → a single space.
    example = example.replace(/\\s[*+]?/g, ' ');

    // Simple literal character classes ([,，] [:：] …) → first char.
    // Content may not contain '[' so a class can't swallow a preceding
    // escaped literal bracket (e.g. the "\[" in "\[100[,，]").
    example = example.replace(/\[([^\[\]\\^]{1,6})\]/g, (_m, chars: string) => chars[0]);

    // Unsupported class shorthands remain → bail.
    if (/\\[dDsSwWbB]/.test(example)) return null;

    // Mask escaped literals so the syntax check below ignores them.
    const escapedLiterals: string[] = [];
    example = example.replace(/\\(.)/g, (_m, ch: string) => {
      escapedLiterals.push(ch);
      return `\u0000${escapedLiterals.length - 1}\u0000`;
    });

    // Any remaining regex metacharacter means an unsupported construct
    // (alternation, quantifiers, nested/non-capturing groups, …).
    if (/[()[\]{}*+?|$^]/.test(example)) return null;

    // Restore escaped literals.
    example = example.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
      const literal = escapedLiterals[Number(i)];
      return literal === '\\' ? '\\' : literal;
    });

    example = example.replace(/ {2,}/g, ' ').trim();
    return example || null;
  } catch {
    return null;
  }
}
