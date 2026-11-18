import type { SystemSettings } from '@/types/settings';
import type { CustomTranslator, TranslationPrompt, TranslationRecords } from '@/types/translation';
export type { TranslationRecords } from '@/types/translation';

const READ_FIELDS = ['translationProvider', 'translateTargetLang'] as const;
const VIEW_FIELDS = ['translationProvider', 'translateTargetLang', 'translationPromptId'] as const;
const DICTIONARY_FIELDS = [
  'contextTranslatorId',
  'contextPromptId',
  'contextSystemPrompt',
  'contextMaxOutputTokens',
] as const;
const PREFERENCE_KEYS = new Set([
  ...READ_FIELDS.map((key) => `read/${key}`),
  ...VIEW_FIELDS.map((key) => `view/${key}`),
  ...DICTIONARY_FIELDS.map((key) => `dictionary/${key}`),
]);
const TRANSLATOR_FIELDS = [
  'id',
  'type',
  'name',
  'baseUrl',
  'apiKey',
  'model',
  'temperature',
  'thinking',
  'disabled',
  'addedAt',
  'updatedAt',
  'reincarnation',
] as const;
const PROMPT_FIELDS = [
  'id',
  'name',
  'systemPrompt',
  'addedAt',
  'updatedAt',
  'reincarnation',
] as const;

const pick = <T extends object>(value: T, keys: readonly (keyof T)[]): Record<string, unknown> =>
  Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );

const stable = (value: unknown): string =>
  JSON.stringify(value, value && typeof value === 'object' ? Object.keys(value).sort() : undefined);

/** Explicit allowlist: never serialize the complete settings object. */
export const snapshotTranslations = (settings: SystemSettings): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const entry of settings.customTranslators ?? []) {
    if (!entry.deletedAt) result[`translator/${entry.id}`] = pick(entry, TRANSLATOR_FIELDS);
  }
  for (const entry of settings.translationPrompts ?? []) {
    if (!entry.deletedAt) result[`prompt/${entry.id}`] = pick(entry, PROMPT_FIELDS);
  }
  for (const key of READ_FIELDS) result[`read/${key}`] = settings.globalReadSettings?.[key] ?? null;
  for (const key of VIEW_FIELDS) result[`view/${key}`] = settings.globalViewSettings?.[key] ?? null;
  for (const key of DICTIONARY_FIELDS)
    result[`dictionary/${key}`] = settings.dictionarySettings?.[key] ?? null;
  return result;
};

/** Stamp edits when they are made locally, not when an offline device reconnects. */
export const trackTranslations = (
  records: TranslationRecords,
  settings: SystemSettings,
  writer: string,
  now: number,
): TranslationRecords => {
  const snapshot = snapshotTranslations(settings);
  const at = Object.values(records).reduce((max, entry) => Math.max(max, entry.at + 1), now);
  let next = records;
  for (const key of new Set([...Object.keys(records), ...Object.keys(snapshot)])) {
    const value = snapshot[key] ?? null;
    if (records[key] && stable(records[key].value) === stable(value)) continue;
    if (next === records) next = { ...records };
    next[key] = { value, writer, at };
  }
  return next;
};

/** LWW per entity/preference, with retained tombstones and deterministic ties. */
export const mergeTranslations = (
  local: TranslationRecords,
  remote: TranslationRecords,
): TranslationRecords => {
  const merged = { ...local };
  for (const [key, entry] of Object.entries(remote)) {
    const old = merged[key];
    if (
      !old ||
      entry.at > old.at ||
      (entry.at === old.at &&
        (entry.writer > old.writer ||
          (entry.writer === old.writer && stable(entry.value) > stable(old.value))))
    ) {
      merged[key] = entry;
    }
  }
  return merged;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reject malformed/unknown documents before applying or publishing anything. */
export const parseTranslationRecords = (value: unknown): TranslationRecords => {
  const invalid = () => new Error('Invalid translation sync document');
  if (!object(value)) throw invalid();
  for (const [key, record] of Object.entries(value)) {
    if (
      !object(record) ||
      !finite(record['at']) ||
      !Number.isSafeInteger(record['at']) ||
      typeof record['writer'] !== 'string'
    )
      throw invalid();
    const entry = record['value'];
    if (PREFERENCE_KEYS.has(key)) {
      if (
        entry !== null &&
        (key === 'dictionary/contextMaxOutputTokens' ? !finite(entry) : typeof entry !== 'string')
      )
        throw invalid();
      continue;
    }
    const match = /^(translator|prompt)\/([a-zA-Z0-9_-]+)$/.exec(key);
    if (!match) throw invalid();
    if (entry === null) continue;
    if (
      !object(entry) ||
      entry['id'] !== match[2] ||
      typeof entry['name'] !== 'string' ||
      !finite(entry['addedAt']) ||
      !finite(entry['updatedAt'])
    )
      throw invalid();
    const fields = match[1] === 'translator' ? TRANSLATOR_FIELDS : PROMPT_FIELDS;
    if (Object.keys(entry).some((field) => !(fields as readonly string[]).includes(field)))
      throw invalid();
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (['addedAt', 'updatedAt', 'temperature'].includes(field)) {
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) throw invalid();
      } else if (field === 'disabled') {
        if (typeof fieldValue !== 'boolean') throw invalid();
      } else if (typeof fieldValue !== 'string') throw invalid();
    }
    if (match[1] === 'translator') {
      if (!['openai-compatible', 'deepl'].includes(String(entry['type']))) throw invalid();
      if (entry['thinking'] !== undefined && entry['thinking'] !== 'off') throw invalid();
    } else if (typeof entry['systemPrompt'] !== 'string') throw invalid();
  }
  return value as TranslationRecords;
};

export const applyTranslations = (
  settings: SystemSettings,
  records: TranslationRecords,
): SystemSettings => {
  parseTranslationRecords(records);
  const next = {
    ...settings,
    customTranslators: [] as CustomTranslator[],
    translationPrompts: [] as TranslationPrompt[],
    globalReadSettings: { ...settings.globalReadSettings },
    globalViewSettings: { ...settings.globalViewSettings },
    dictionarySettings: { ...settings.dictionarySettings },
  };
  for (const [key, record] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith('translator/') && record.value) {
      const translator = record.value as CustomTranslator;
      const local = settings.customTranslators?.find((entry) => entry.id === translator.id);
      next.customTranslators.push({
        ...translator,
        ...(local?.lastSeenCipher ? { lastSeenCipher: { ...local.lastSeenCipher } } : {}),
      });
    }
    if (key.startsWith('prompt/') && record.value)
      next.translationPrompts.push({ ...(record.value as TranslationPrompt) });
  }
  for (const key of READ_FIELDS) {
    const value = records[`read/${key}`]?.value;
    if (typeof value === 'string') next.globalReadSettings[key] = value;
  }
  for (const key of VIEW_FIELDS) {
    const record = records[`view/${key}`];
    if (typeof record?.value === 'string') next.globalViewSettings[key] = record.value;
    else if (record && key === 'translationPromptId') delete next.globalViewSettings[key];
  }
  for (const key of DICTIONARY_FIELDS) {
    const record = records[`dictionary/${key}`];
    if (!record) continue;
    if (record.value === null) delete next.dictionarySettings[key];
    else if (key === 'contextMaxOutputTokens')
      next.dictionarySettings[key] = record.value as number;
    else next.dictionarySettings[key] = record.value as string;
  }
  return next;
};
