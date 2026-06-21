/**
 * Lightweight i18n system — no external dependency.
 *
 * Usage:
 *   const t = useI18n();
 *   t('lab.title')
 *
 * Language preference is persisted in localStorage.
 */

import { useCallback, useEffect, useState } from 'react';

export type Locale = 'zh' | 'en';

export const LOCALES: Locale[] = ['zh', 'en'];

const STORAGE_KEY = 'miko.locale';

// ---------------------------------------------------------------------------
// Translation dictionaries
// ---------------------------------------------------------------------------

const zh: Record<string, string> = {
  // App
  'app.title': 'Miko Lab',
  'app.subtitle': '图像标注试验台',

  // Nav
  'nav.lab': 'Lab',
  'nav.prompts': '提示词',
  'nav.samples': '样本',
  'nav.runs': '运行',
  'nav.pricing': '定价',
  'nav.settings': '设置',

  // Lab
  'lab.title': '实验台',
  'lab.description': '编写提示词，附加图片，运行单次实验。',
  'lab.run': '运行',
  'lab.running': '运行中…',
  'lab.cost': '成本',

  // Model bar
  'model.providerType': '平台类型',
  'model.providerId': 'Provider ID',
  'model.providerConfig': '提供商配置',
  'model.manageInSettings': '在设置中管理',
  'model.modelId': '模型 ID',
  'model.baseUrl': 'API Base URL',
  'model.baseUrlRequired': 'Base URL（必填）',
  'model.baseUrlOptional': 'Base URL（可选）',
  'model.temperature': 'Temperature',
  'model.maxOutputTokens': '最大输出 Tokens',
  'model.thinking': '思考模式',
  'model.enableThinking': '启用思考',
  'model.thinkingBudget': '思考预算',
  'model.reasoningEffort': '推理强度',
  'model.fetchModels': '获取模型列表',
  'model.fetching': '获取中…',
  'model.modelsLoaded': '已加载 {count} 个模型',
  'model.fetchFailed': '获取模型列表失败',
  'model.noModels': '暂无模型，请先获取或手动输入',

  // Image panel
  'image.title': '图片',
  'image.dropHere': '拖拽图片到此处，或点击选择',
  'image.role': '角色',
  'image.remove': '移除',

  // Prompt panel
  'prompt.systemPrompt': 'System Prompt',
  'prompt.userPrompt': 'User Prompt',
  'prompt.formatInstruction': '格式说明',
  'prompt.outputMode': '输出模式',
  'prompt.mode.freeText': '自由文本',
  'prompt.mode.softSections': '温和分节',
  'prompt.mode.looseJson': '宽松 JSON',
  'prompt.mode.strictJson': '严格 JSON',
  'prompt.mode.custom': '自定义',

  // Result panel
  'result.title': '结果',
  'result.raw': '原始输出',
  'result.parsed': '解析结果',
  'result.usage': 'Token 用量',
  'result.cost': '成本',
  'result.empty': '运行后结果将显示在此',
  'result.inputTokens': '输入 Tokens',
  'result.outputTokens': '输出 Tokens',
  'result.totalTokens': '总计 Tokens',
  'result.latency': '耗时',
  'result.error': '错误',
  'result.runningExperiment': '运行实验中…',
  'result.runToSee': '运行实验以查看结果',
  'result.partiallyParsed': '部分解析',
  'result.pending': '等待中',
  'result.image': '图片',
  'result.noRawOutput': '无原始输出',
  'result.parseFailed': '解析失败',
  'result.notParsed': '未解析',
  'result.succeeded': '成功',
  'result.failed': '失败',

  // Prompt panel additions
  'prompt.title': '提示词与输出',
  'prompt.outputContractMode': '输出合约模式',
  'prompt.sectionNames': '节名称（逗号分隔）',
  'prompt.sectionNamesPlaceholder': 'summary, tags, caption',
  'prompt.jsonSchema': 'JSON Schema（可选）',
  'prompt.invalidJsonSchema': '无效的 JSON Schema',
  'prompt.imageRefHint': '💡 使用 {{image:0}}、{{image:1}} 等在提示词中指定图片出现位置',

  // Image panel additions
  'image.add': '添加',
  'image.uploading': '正在上传 {count} 张…',
  'image.fallback': '图片 {n}',

  // Run history
  'history.title': '运行历史',
  'history.empty': '暂无运行记录',
  'history.status': '状态',
  'history.time': '时间',
  'history.name': '名称',
  'history.created': '创建时间',
  'history.view': '查看',
  'history.loading': '加载中…',
  'history.statusCompleted': '已完成',
  'history.statusFailed': '失败',
  'history.statusRunning': '运行中',
  'history.statusPartial': '部分完成',
  'history.statusUnknown': '未知',

  // Settings
  'settings.title': 'API Keys',
  'settings.providerConfigs': '提供商配置',
  'settings.addProviderConfig': '添加提供商配置',
  'settings.configName': '名称',
  'settings.configType': '类型',
  'settings.noProviderConfigs': '尚未配置任何提供商。在下方添加一个以开始使用。',
  'settings.notes': '备注',
  'settings.description':
    'API 密钥加密存储在本地数据库中，不会出现在运行记录或导出文件里。',
  'settings.addKey': '添加 API Key',
  'settings.provider': 'Provider',
  'settings.apiKey': 'API Key',
  'settings.save': '保存密钥',
  'settings.saved': '已保存',
  'settings.remove': '删除密钥',
  'settings.noKeys': '尚未存储任何 API Key。在下方添加一个以开始使用。',
  'settings.loading': '加载中…',
  'settings.providerHint': '使用小写的平台标识（如 openai、qwen、deepseek）。平台 ID 需与模型配置中的 provider_id 一致。',

  // Misc
  'common.confirm': '确认',
  'common.cancel': '取消',
  'common.addImage': '添加图片',
};

const en: Record<string, string> = {
  // App
  'app.title': 'Miko Lab',
  'app.subtitle': 'Image Annotation Lab',

  // Nav
  'nav.lab': 'Lab',
  'nav.prompts': 'Prompts',
  'nav.samples': 'Samples',
  'nav.runs': 'Runs',
  'nav.pricing': 'Pricing',
  'nav.settings': 'Settings',

  // Lab
  'lab.title': 'Experiment Lab',
  'lab.description': 'Compose prompts, attach images, and run single-shot experiments.',
  'lab.run': 'Run',
  'lab.running': 'Running…',
  'lab.cost': 'Cost',

  // Model bar
  'model.providerType': 'Provider Type',
  'model.providerId': 'Provider ID',
  'model.providerConfig': 'Provider Config',
  'model.manageInSettings': 'Manage in Settings',
  'model.modelId': 'Model ID',
  'model.baseUrl': 'API Base URL',
  'model.baseUrlRequired': 'Base URL (required)',
  'model.baseUrlOptional': 'Base URL (optional)',
  'model.temperature': 'Temperature',
  'model.maxOutputTokens': 'Max Output Tokens',
  'model.thinking': 'Thinking',
  'model.enableThinking': 'Enable Thinking',
  'model.thinkingBudget': 'Thinking Budget',
  'model.reasoningEffort': 'Reasoning Effort',
  'model.fetchModels': 'Fetch Models',
  'model.fetching': 'Fetching…',
  'model.modelsLoaded': '{count} models loaded',
  'model.fetchFailed': 'Failed to fetch models',
  'model.noModels': 'No models yet — fetch from API or type manually',

  // Image panel
  'image.title': 'Images',
  'image.dropHere': 'Drop images here, or click to select',
  'image.role': 'Role',
  'image.remove': 'Remove',

  // Prompt panel
  'prompt.systemPrompt': 'System Prompt',
  'prompt.userPrompt': 'User Prompt',
  'prompt.formatInstruction': 'Format Instruction',
  'prompt.outputMode': 'Output Mode',
  'prompt.mode.freeText': 'Free Text',
  'prompt.mode.softSections': 'Soft Sections',
  'prompt.mode.looseJson': 'Loose JSON',
  'prompt.mode.strictJson': 'Strict JSON',
  'prompt.mode.custom': 'Custom',

  // Result panel
  'result.title': 'Result',
  'result.raw': 'Raw Output',
  'result.parsed': 'Parsed',
  'result.usage': 'Usage',
  'result.cost': 'Cost',
  'result.empty': 'Results will appear here after running',
  'result.inputTokens': 'Input Tokens',
  'result.outputTokens': 'Output Tokens',
  'result.totalTokens': 'Total Tokens',
  'result.latency': 'Latency',
  'result.error': 'Error',
  'result.runningExperiment': 'Running experiment…',
  'result.runToSee': 'Run an experiment to see results.',
  'result.partiallyParsed': 'Partially Parsed',
  'result.pending': 'Pending',
  'result.image': 'Image',
  'result.noRawOutput': 'No raw output available.',
  'result.parseFailed': 'Parse Failed',
  'result.notParsed': 'Not parsed.',
  'result.succeeded': 'Succeeded',
  'result.failed': 'Failed',

  // Prompt panel additions
  'prompt.title': 'Prompts & Output',
  'prompt.outputContractMode': 'Output Contract Mode',
  'prompt.sectionNames': 'Section Names (comma separated)',
  'prompt.sectionNamesPlaceholder': 'summary, tags, caption',
  'prompt.jsonSchema': 'JSON Schema (optional)',
  'prompt.invalidJsonSchema': 'Invalid JSON schema',
  'prompt.imageRefHint': '💡 Use {{image:0}}, {{image:1}} etc. to insert images at specific positions in the prompt.',

  // Image panel additions
  'image.add': 'Add',
  'image.uploading': 'Uploading {count}…',
  'image.fallback': 'Image {n}',

  // Run history
  'history.title': 'Run History',
  'history.empty': 'No runs yet',
  'history.status': 'Status',
  'history.time': 'Time',
  'history.name': 'Name',
  'history.created': 'Created',
  'history.view': 'View',
  'history.loading': 'Loading…',
  'history.statusCompleted': 'Completed',
  'history.statusFailed': 'Failed',
  'history.statusRunning': 'Running',
  'history.statusPartial': 'Partial',
  'history.statusUnknown': 'Unknown',

  // Settings
  'settings.title': 'API Keys',
  'settings.providerConfigs': 'Provider Configs',
  'settings.addProviderConfig': 'Add Provider Config',
  'settings.configName': 'Name',
  'settings.configType': 'Type',
  'settings.noProviderConfigs': 'No provider configs yet. Add one below to get started.',
  'settings.notes': 'Notes',
  'settings.description':
    'API keys are encrypted at rest and stored in the local database. They never appear in run records or exports.',
  'settings.addKey': 'Add API Key',
  'settings.provider': 'Provider',
  'settings.apiKey': 'API Key',
  'settings.save': 'Save Key',
  'settings.saved': 'saved',
  'settings.remove': 'Remove key',
  'settings.noKeys': 'No API keys stored. Add one below to get started.',
  'settings.loading': 'Loading…',
  'settings.providerHint':
    'Use lowercase provider identifiers (e.g. openai, qwen, deepseek). The provider ID must match the provider_id used in model configs.',

  // Misc
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.addImage': 'Add Image',
};

const DICTS: Record<Locale, Record<string, string>> = { zh, en };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  // Auto-detect from browser language
  return navigator.language.startsWith('zh') ? 'zh' : 'en';
}

let currentLocale: Locale = getInitialLocale();
const listeners = new Set<(locale: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  listeners.forEach((fn) => fn(locale));
}

export function translate(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLocale] ?? DICTS.zh;
  let value = dict[key] ?? DICTS.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(currentLocale);

  useEffect(() => {
    const fn = (l: Locale) => setLocaleState(l);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, params),
    [locale],
  );

  const changeLocale = useCallback((l: Locale) => {
    setLocale(l);
  }, []);

  return { t, locale, setLocale: changeLocale };
}
