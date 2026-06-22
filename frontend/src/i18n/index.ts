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
  'nav.tasks': 'Tasks',
  'nav.prompts': '提示词',
  'nav.samples': '样本',
  'nav.runs': '运行',
  'nav.snapshots': '快照',
  'nav.pricing': '定价',
  'nav.settings': '设置',

  // Lab
  'lab.title': '实验台',
  'lab.description': '编写提示词，附加图片，运行单次实验。',
  'lab.run': '运行',
  'lab.running': '运行中…',
  'lab.cost': '成本',
  'lab.viewMode.edit': '编辑',
  'lab.viewMode.promptResult': '提示词+结果',
  'lab.viewMode.imageResult': '图片+结果',
  'lab.showHistory': '显示历史',
  'lab.hideHistory': '隐藏历史',

  // Task
  'task.title': 'Tasks',
  'task.description': '保存和复用 Lab 配置模板。',
  'task.saveAsTask': '保存为 Task',
  'task.name': '名称',
  'task.notes': '备注',
  'task.load': '载入 Lab',
  'task.delete': '删除',
  'task.empty': '暂无 Task。在 Lab 中点击“保存为 Task”创建一个。',
  'task.loading': '加载中…',
  'task.model': '模型',
  'task.providerConfig': '提供商配置',
  'task.updatedAt': '更新时间',
  'task.saved': '已保存',
  'task.nameRequired': '请输入 Task 名称',
  'task.saveFailed': '保存 Task 失败',
  'task.loadFailed': '加载 Task 列表失败',
  'task.deleteFailed': '删除 Task 失败',

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
  'model.topP': 'Top P',
  'model.thinking': '思考模式',
  'model.enableThinking': '启用思考',
  'model.thinkingBudget': '思考预算',
  'model.reasoningEffort': '推理强度',
  'model.streaming': '流式输出',
  'model.enableStreaming': '启用流式输出',
  'model.modelsLoaded': '已加载 {count} 个模型',
  'model.cacheStatus': '已缓存 {count} 个模型',
  'model.cacheEmpty': '尚未缓存模型列表',
  'model.cachedAt': '缓存于 {time}',
  'model.fetchFailed': '获取模型列表失败',
  'model.noModels': '暂无模型，请先获取或手动输入',
  'model.selectOrType': '输入或选择模型 ID',
  'model.parameters': '参数',

  // Pricing
  'pricing.title': '定价',
  'pricing.description': '按提供商配置和模型配置 token、图片价格与折扣。Lab 会使用匹配价格估算成本。',
  'pricing.empty': '暂无价格配置。',
  'pricing.add': '添加价格',
  'pricing.save': '保存价格',
  'pricing.active': '当前价格',
  'pricing.providerConfig': '提供商配置',
  'pricing.model': '模型 ID',
  'pricing.input': '输入/1M',
  'pricing.output': '输出/1M',
  'pricing.inputShort': '输入',
  'pricing.outputShort': '输出',
  'pricing.cached': '缓存输入/1M',
  'pricing.image': '图片',
  'pricing.imageShort': '图片',
  'pricing.imageToken': '图片 token',
  'pricing.imageRequest': '每图固定价',
  'pricing.imageNone': '无图片价格',
  'pricing.imagePrice': '图片价格',
  'pricing.discount': '折扣',
  'pricing.discountShort': '折扣',
  'pricing.currency': '币种',
  'pricing.noActive': '未配置定价',

  // Image panel
  'image.title': '图片',
  'image.dropHere': '拖拽或点击添加图片',
  'image.role': '角色',
  'image.remove': '移除',

  // Prompt panel
  'prompt.systemPrompt': 'System Prompt',
  'prompt.systemPromptHint': '定义任务角色、输出格式与约束',
  'prompt.userPrompt': 'User Prompt',
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
  'result.streaming': '流式输出中…',
  'result.runToSee': '运行实验以查看结果',
  'result.partiallyParsed': '部分解析',
  'result.pending': '等待中',
  'result.image': '图片',
  'result.noRawOutput': '无原始输出',
  'result.parseFailed': '解析失败',
  'result.notParsed': '未解析',
  'result.succeeded': '成功',
  'result.failed': '失败',
  'result.showRaw': '展开原始输出',
  'result.hideRaw': '收起原始输出',
  'result.reasoning': '推理过程',
  'result.showReasoning': '展开推理过程',
  'result.hideReasoning': '收起推理过程',

  // Snapshot
  'snapshot.title': '结果快照',
  'snapshot.description': '保存、标注并复用实验结果。',
  'snapshot.save': '保存快照',
  'snapshot.saveSuccess': '快照已保存',
  'snapshot.name': '名称',
  'snapshot.nameRequired': '请输入快照名称',
  'snapshot.descriptionLabel': '描述',
  'snapshot.tags': '标签',
  'snapshot.tagsHint': '用逗号分隔',
  'snapshot.notes': '备注',
  'snapshot.starred': '收藏',
  'snapshot.accepted': '已接受',
  'snapshot.rating': '评分',
  'snapshot.provider': '提供商',
  'snapshot.model': '模型',
  'snapshot.createdAt': '创建时间',
  'snapshot.updatedAt': '更新时间',
  'snapshot.loadIntoLab': '载入 Lab',
  'snapshot.delete': '删除',
  'snapshot.empty': '暂无快照。在 Lab 中运行实验并点击“保存快照”创建一个。',
  'snapshot.loading': '加载中…',
  'snapshot.search': '搜索快照',
  'snapshot.filterStarred': '仅看收藏',
  'snapshot.filterTag': '标签',
  'snapshot.allTags': '全部标签',
  'snapshot.metadata': '元数据',
  'snapshot.runResult': '运行结果',
  'snapshot.edit': '编辑',
  'snapshot.cancel': '取消',
  'snapshot.confirmDelete': '确定要删除这个快照吗？',
  'snapshot.confirmBatchDelete': '确定要删除选中的 {count} 个快照吗？',
  'snapshot.batchMode': '批量管理',
  'snapshot.selectAll': '全选',
  'snapshot.deselectAll': '取消全选',
  'snapshot.selectedCount': '已选 {count} 个',
  'snapshot.batchDelete': '批量删除',
  'snapshot.loadFailed': '加载快照列表失败',
  'snapshot.saveFailed': '保存快照失败',
  'snapshot.updateFailed': '更新快照失败',
  'snapshot.deleteFailed': '删除快照失败',
  'snapshot.detailFailed': '加载快照详情失败',
  'snapshot.runConfig': '运行配置',
  'snapshot.prompt': '提示词',
  'snapshot.modelConfig': '模型配置',
  'snapshot.outputContract': '输出合约',
  'snapshot.noResult': '无运行结果数据',
  'snapshot.imagesUsed': '当时所用图片',

  // Prompt panel additions
  'prompt.title': '提示词与输出',
  'prompt.outputContractMode': '输出合约模式',
  'prompt.sectionNames': '节名称（逗号分隔）',
  'prompt.sectionNamesPlaceholder': 'summary, tags, caption',
  'prompt.jsonSchema': 'JSON Schema（可选）',
  'prompt.invalidJsonSchema': '无效的 JSON Schema',
  'prompt.imageRefHint': '💡 点击“插入图片”将图片引用嵌入提示词；拖拽引用可调整顺序，点击 × 移除。',
  'prompt.images': '已添加图片',
  'prompt.insertImage': '插入图片',
  'prompt.insertImageAtCursor': '在当前位置插入',
  'prompt.preview': '预览',
  'prompt.edit': '编辑',
  'prompt.imageInserted': '已插入',
  'prompt.noImages': '暂无图片',
  'prompt.empty': '在此输入提示词…',

  // Prompt library
  'prompt.libraryDescription': '保存和复用可复用的提示词模板，含图像槽位与 few-shot 示例。',
  'prompt.createPrompt': '新建提示词',
  'prompt.name': '名称',
  'prompt.namePlaceholder': '例如：服装标注模板',
  'prompt.nameRequired': '请输入提示词名称',
  'prompt.userTemplate': 'User Template',
  'prompt.userTemplatePlaceholder': '在此输入 user template，可用 {{image:N}} 引用图片…',
  'prompt.userTemplateHint': '使用 {{image:N}} 引用图片，N 为图片索引。',
  'prompt.noUserTemplate': '（无 user template）',
  'prompt.notes': '备注',
  'prompt.save': '保存',
  'prompt.saved': '已保存',
  'prompt.loading': '加载中…',
  'prompt.loadFailed': '加载提示词失败',
  'prompt.saveFailed': '保存提示词失败',
  'prompt.emptyLibrary': '暂无提示词模板。点击右上角“新建提示词”创建一个。',
  'prompt.loadIntoLab': '载入 Lab',
  'prompt.imageSlotSpecs': '图像槽位',
  'prompt.addImageSlot': '添加槽位',
  'prompt.imageSlot': '槽位',
  'prompt.imageSlotLabel': '标签，例如：目标图片',
  'prompt.imageSlotDescription': '描述，例如：需要标注的原始图片',
  'prompt.noImageSlots': '未定义图像槽位',
  'prompt.required': '必需',
  'prompt.minCount': '最小数量',
  'prompt.maxCount': '最大数量',
  'prompt.unlimited': '不限',
  'prompt.moveUp': '上移',
  'prompt.moveDown': '下移',
  'prompt.deleteImageSlot': '删除槽位',
  'prompt.fewShotExamples': 'Few-shot 示例',
  'prompt.addFewShotExample': '添加示例',
  'prompt.noFewShotExamples': '暂无 few-shot 示例',
  'prompt.fewShotExample': '示例',
  'prompt.fewShotTitle': '标题',
  'prompt.fewShotInput': '输入',
  'prompt.fewShotOutput': '输出',
  'prompt.fewShotEnabled': '启用',
  'prompt.deleteFewShotExample': '删除示例',
  'prompt.disabled': '已禁用',
  'prompt.expectedImageSlots': '期望图像槽位',
  'prompt.imageSlotCount': '{count} 个槽位',
  'prompt.fewShotCount': '{count} 个示例',
  'prompt.useAsFewShot': '用作 few-shot',
  'prompt.useAsFewShotTitle': '将结果保存为 few-shot example',
  'prompt.targetPrompt': '目标提示词',
  'prompt.selectPrompt': '选择提示词',
  'prompt.appendExample': '追加为新的 example',
  'prompt.replaceLatest': '替换最新的 example',
  'prompt.replaceSelected': '替换选中的 example',
  'prompt.exampleTitle': 'example 标题',
  'prompt.noPrompts': '没有可用的提示词，请先创建一个。',
  'prompt.fewShotSaved': 'few-shot example 已保存',
  'prompt.createNewPrompt': '新建提示词',
  'prompt.updateExistingPrompt': '更新现有提示词',
  'prompt.newPromptName': '新提示词名称',
  'prompt.copyRunPrompt': '复制运行时的 system/user prompt',
  'prompt.delete': '删除',
  'prompt.confirmDelete': '确定要删除这个提示词吗？',
  'prompt.confirmBatchDelete': '确定要删除选中的 {count} 个提示词吗？',
  'prompt.batchMode': '批量管理',
  'prompt.selectAll': '全选',
  'prompt.deselectAll': '取消全选',
  'prompt.selectedCount': '已选 {count} 个',
  'prompt.batchDelete': '批量删除',
  'prompt.search': '搜索提示词',

  // Image panel additions
  'image.add': '添加',
  'image.uploading': '正在上传 {count} 张…',
  'image.fallback': '图片 {n}',
  'image.resolutionEnabled': '启用分辨率限制',
  'image.resolutionTarget': '目标分辨率',

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
  'settings.providerConfigs': '提供商配置',
  'settings.addProviderConfig': '添加提供商配置',
  'settings.configName': '名称',
  'settings.configType': '类型',
  'settings.noProviderConfigs': '尚未配置任何提供商。在下方添加一个以开始使用。',
  'settings.notes': '备注',
  'settings.apiKey': 'API Key',
  'settings.save': '保存密钥',
  'settings.saved': '已保存',
  'settings.remove': '删除密钥',
  'settings.loading': '加载中…',
  'settings.syncModels': '同步模型列表',
  'settings.modelCacheStatus': '已缓存 {count} 个模型',
  'settings.modelCacheEmpty': '尚未缓存模型列表',
  'settings.modelCacheAt': '缓存于 {time}',
  'settings.selectedModels': 'Lab 可用模型',
  'settings.allModels': '使用全部模型',
  'settings.selectAll': '全选',
  'settings.invertSelection': '反选',

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
  'nav.tasks': 'Tasks',
  'nav.prompts': 'Prompts',
  'nav.samples': 'Samples',
  'nav.runs': 'Runs',
  'nav.snapshots': 'Snapshots',
  'nav.pricing': 'Pricing',
  'nav.settings': 'Settings',

  // Lab
  'lab.title': 'Experiment Lab',
  'lab.description': 'Compose prompts, attach images, and run single-shot experiments.',
  'lab.run': 'Run',
  'lab.running': 'Running…',
  'lab.cost': 'Cost',
  'lab.viewMode.edit': 'Edit',
  'lab.viewMode.promptResult': 'Prompt + Result',
  'lab.viewMode.imageResult': 'Image + Result',
  'lab.showHistory': 'Show history',
  'lab.hideHistory': 'Hide history',

  // Task
  'task.title': 'Tasks',
  'task.description': 'Save and reuse Lab configuration templates.',
  'task.saveAsTask': 'Save as Task',
  'task.name': 'Name',
  'task.notes': 'Notes',
  'task.load': 'Load into Lab',
  'task.delete': 'Delete',
  'task.empty': 'No Tasks yet. Create one from the Lab with “Save as Task”.',
  'task.loading': 'Loading…',
  'task.model': 'Model',
  'task.providerConfig': 'Provider config',
  'task.updatedAt': 'Updated',
  'task.saved': 'Saved',
  'task.nameRequired': 'Task name is required',
  'task.saveFailed': 'Failed to save Task',
  'task.loadFailed': 'Failed to load Tasks',
  'task.deleteFailed': 'Failed to delete Task',

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
  'model.topP': 'Top P',
  'model.thinking': 'Thinking',
  'model.enableThinking': 'Enable Thinking',
  'model.thinkingBudget': 'Thinking Budget',
  'model.reasoningEffort': 'Reasoning Effort',
  'model.streaming': 'Streaming',
  'model.enableStreaming': 'Enable Streaming',
  'model.modelsLoaded': '{count} models loaded',
  'model.cacheStatus': '{count} models cached',
  'model.cacheEmpty': 'No cached model list yet',
  'model.cachedAt': 'cached at {time}',
  'model.fetchFailed': 'Failed to fetch models',
  'model.noModels': 'No models yet — fetch from API or type manually',
  'model.selectOrType': 'Select or type a model ID',
  'model.parameters': 'Parameters',

  // Pricing
  'pricing.title': 'Pricing',
  'pricing.description': 'Configure token prices, image prices, and discounts per provider config and model. The Lab uses matching rows for cost estimates.',
  'pricing.empty': 'No pricing profiles yet.',
  'pricing.add': 'Add Pricing',
  'pricing.save': 'Save Pricing',
  'pricing.active': 'Active pricing',
  'pricing.providerConfig': 'Provider Config',
  'pricing.model': 'Model ID',
  'pricing.input': 'Input/1M',
  'pricing.output': 'Output/1M',
  'pricing.inputShort': 'in',
  'pricing.outputShort': 'out',
  'pricing.cached': 'Cached input/1M',
  'pricing.image': 'Image',
  'pricing.imageShort': 'img',
  'pricing.imageToken': 'Image tokens',
  'pricing.imageRequest': 'Per image',
  'pricing.imageNone': 'No image price',
  'pricing.imagePrice': 'Image price',
  'pricing.discount': 'Discount',
  'pricing.discountShort': 'discount',
  'pricing.currency': 'Currency',
  'pricing.noActive': 'No pricing',

  // Image panel
  'image.title': 'Images',
  'image.dropHere': 'Drop or click to add images',
  'image.role': 'Role',
  'image.remove': 'Remove',

  // Prompt panel
  'prompt.systemPrompt': 'System Prompt',
  'prompt.systemPromptHint': 'Define role, output format and constraints',
  'prompt.userPrompt': 'User Prompt',
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
  'result.streaming': 'Streaming…',
  'result.runToSee': 'Run an experiment to see results.',
  'result.partiallyParsed': 'Partially Parsed',
  'result.pending': 'Pending',
  'result.image': 'Image',
  'result.noRawOutput': 'No raw output available.',
  'result.parseFailed': 'Parse Failed',
  'result.notParsed': 'Not parsed.',
  'result.succeeded': 'Succeeded',
  'result.failed': 'Failed',
  'result.showRaw': 'Show raw output',
  'result.hideRaw': 'Hide raw output',
  'result.reasoning': 'Reasoning',
  'result.showReasoning': 'Show reasoning',
  'result.hideReasoning': 'Hide reasoning',

  // Snapshot
  'snapshot.title': 'Result Snapshots',
  'snapshot.description': 'Save, annotate, and reuse experiment results.',
  'snapshot.save': 'Save Snapshot',
  'snapshot.saveSuccess': 'Snapshot saved',
  'snapshot.name': 'Name',
  'snapshot.nameRequired': 'Snapshot name is required',
  'snapshot.descriptionLabel': 'Description',
  'snapshot.tags': 'Tags',
  'snapshot.tagsHint': 'Comma separated',
  'snapshot.notes': 'Notes',
  'snapshot.starred': 'Starred',
  'snapshot.accepted': 'Accepted',
  'snapshot.rating': 'Rating',
  'snapshot.provider': 'Provider',
  'snapshot.model': 'Model',
  'snapshot.createdAt': 'Created',
  'snapshot.updatedAt': 'Updated',
  'snapshot.loadIntoLab': 'Load into Lab',
  'snapshot.delete': 'Delete',
  'snapshot.empty': 'No snapshots yet. Run an experiment in the Lab and click “Save Snapshot”.',
  'snapshot.loading': 'Loading…',
  'snapshot.search': 'Search snapshots',
  'snapshot.filterStarred': 'Starred only',
  'snapshot.filterTag': 'Tag',
  'snapshot.allTags': 'All tags',
  'snapshot.metadata': 'Metadata',
  'snapshot.runResult': 'Run result',
  'snapshot.edit': 'Edit',
  'snapshot.cancel': 'Cancel',
  'snapshot.confirmDelete': 'Delete this snapshot?',
  'snapshot.confirmBatchDelete': 'Delete the selected {count} snapshots?',
  'snapshot.batchMode': 'Batch manage',
  'snapshot.selectAll': 'Select all',
  'snapshot.deselectAll': 'Deselect all',
  'snapshot.selectedCount': '{count} selected',
  'snapshot.batchDelete': 'Batch delete',
  'snapshot.loadFailed': 'Failed to load snapshots',
  'snapshot.saveFailed': 'Failed to save snapshot',
  'snapshot.updateFailed': 'Failed to update snapshot',
  'snapshot.deleteFailed': 'Failed to delete snapshot',
  'snapshot.detailFailed': 'Failed to load snapshot detail',
  'snapshot.runConfig': 'Run config',
  'snapshot.prompt': 'Prompt',
  'snapshot.modelConfig': 'Model config',
  'snapshot.outputContract': 'Output contract',
  'snapshot.noResult': 'No run result data',
  'snapshot.imagesUsed': 'Images used',

  // Prompt panel additions
  'prompt.title': 'Prompts & Output',
  'prompt.outputContractMode': 'Output Contract Mode',
  'prompt.sectionNames': 'Section Names (comma separated)',
  'prompt.sectionNamesPlaceholder': 'summary, tags, caption',
  'prompt.jsonSchema': 'JSON Schema (optional)',
  'prompt.invalidJsonSchema': 'Invalid JSON schema',
  'prompt.imageRefHint': '💡 Use “Insert image” to embed image references inline; drag references to reorder, click × to remove.',
  'prompt.images': 'Attached images',
  'prompt.insertImage': 'Insert image',
  'prompt.insertImageAtCursor': 'Insert at cursor',
  'prompt.preview': 'Preview',
  'prompt.edit': 'Edit',
  'prompt.imageInserted': 'Inserted',
  'prompt.noImages': 'No images',
  'prompt.empty': 'Type your prompt here…',

  // Prompt library
  'prompt.libraryDescription': 'Save and reuse prompt templates with image slots and few-shot examples.',
  'prompt.createPrompt': 'Create prompt',
  'prompt.name': 'Name',
  'prompt.namePlaceholder': 'e.g. clothing caption template',
  'prompt.nameRequired': 'Prompt name is required',
  'prompt.userTemplate': 'User Template',
  'prompt.userTemplatePlaceholder': 'Type user template; use {{image:N}} to reference images…',
  'prompt.userTemplateHint': 'Use {{image:N}} to reference images, where N is the image index.',
  'prompt.noUserTemplate': '(no user template)',
  'prompt.notes': 'Notes',
  'prompt.save': 'Save',
  'prompt.saved': 'Saved',
  'prompt.loading': 'Loading…',
  'prompt.loadFailed': 'Failed to load prompts',
  'prompt.saveFailed': 'Failed to save prompt',
  'prompt.emptyLibrary': 'No prompts yet. Click “Create prompt” to add one.',
  'prompt.loadIntoLab': 'Load into Lab',
  'prompt.imageSlotSpecs': 'Image slots',
  'prompt.addImageSlot': 'Add slot',
  'prompt.imageSlot': 'Slot',
  'prompt.imageSlotLabel': 'Label, e.g. Target image',
  'prompt.imageSlotDescription': 'Description, e.g. the original image to annotate',
  'prompt.noImageSlots': 'No image slots defined',
  'prompt.required': 'Required',
  'prompt.minCount': 'Min count',
  'prompt.maxCount': 'Max count',
  'prompt.unlimited': 'Unlimited',
  'prompt.moveUp': 'Move up',
  'prompt.moveDown': 'Move down',
  'prompt.deleteImageSlot': 'Delete slot',
  'prompt.fewShotExamples': 'Few-shot examples',
  'prompt.addFewShotExample': 'Add example',
  'prompt.noFewShotExamples': 'No few-shot examples yet',
  'prompt.fewShotExample': 'Example',
  'prompt.fewShotTitle': 'Title',
  'prompt.fewShotInput': 'Input',
  'prompt.fewShotOutput': 'Output',
  'prompt.fewShotEnabled': 'Enabled',
  'prompt.deleteFewShotExample': 'Delete example',
  'prompt.disabled': 'Disabled',
  'prompt.expectedImageSlots': 'Expected image slots',
  'prompt.imageSlotCount': '{count} slots',
  'prompt.fewShotCount': '{count} examples',
  'prompt.useAsFewShot': 'Use as few-shot',
  'prompt.useAsFewShotTitle': 'Save result as few-shot example',
  'prompt.targetPrompt': 'Target prompt',
  'prompt.selectPrompt': 'Select prompt',
  'prompt.appendExample': 'Append as new example',
  'prompt.replaceLatest': 'Replace latest example',
  'prompt.replaceSelected': 'Replace selected example',
  'prompt.exampleTitle': 'Example title',
  'prompt.noPrompts': 'No prompts available. Create one first.',
  'prompt.fewShotSaved': 'Few-shot example saved',
  'prompt.createNewPrompt': 'Create new prompt',
  'prompt.updateExistingPrompt': 'Update existing prompt',
  'prompt.newPromptName': 'New prompt name',
  'prompt.copyRunPrompt': 'Copy system/user prompt from run',
  'prompt.delete': 'Delete',
  'prompt.confirmDelete': 'Delete this prompt?',
  'prompt.confirmBatchDelete': 'Delete the selected {count} prompts?',
  'prompt.batchMode': 'Batch manage',
  'prompt.selectAll': 'Select all',
  'prompt.deselectAll': 'Deselect all',
  'prompt.selectedCount': '{count} selected',
  'prompt.batchDelete': 'Batch delete',
  'prompt.search': 'Search prompts',

  // Image panel additions
  'image.add': 'Add',
  'image.uploading': 'Uploading {count}…',
  'image.fallback': 'Image {n}',
  'image.resolutionEnabled': 'Limit resolution',
  'image.resolutionTarget': 'Target resolution',

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
  'settings.providerConfigs': 'Provider Configs',
  'settings.addProviderConfig': 'Add Provider Config',
  'settings.configName': 'Name',
  'settings.configType': 'Type',
  'settings.noProviderConfigs': 'No provider configs yet. Add one below to get started.',
  'settings.notes': 'Notes',
  'settings.apiKey': 'API Key',
  'settings.save': 'Save Key',
  'settings.saved': 'saved',
  'settings.remove': 'Remove key',
  'settings.loading': 'Loading…',
  'settings.syncModels': 'Sync models',
  'settings.modelCacheStatus': '{count} models cached',
  'settings.modelCacheEmpty': 'No cached model list yet',
  'settings.modelCacheAt': 'cached at {time}',
  'settings.selectedModels': 'Models exposed in Lab',
  'settings.allModels': 'Use all models',
  'settings.selectAll': 'Select All',
  'settings.invertSelection': 'Invert',

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
