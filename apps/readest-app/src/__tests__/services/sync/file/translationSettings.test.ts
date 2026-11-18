import { describe, expect, test } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { sanitizeSettingsForBackup } from '@/services/backupService';
import {
  applyTranslations,
  mergeTranslations,
  snapshotTranslations,
  trackTranslations,
} from '@/services/sync/file/translationSettings';

const settings = () =>
  ({
    localBooksDir: '/device/books',
    webdav: { enabled: true, password: 'local-dav-password' },
    customTranslators: [
      {
        id: 'translator-a',
        name: 'Translator',
        type: 'openai-compatible',
        apiKey: 'test-api-key',
        model: 'model-a',
        addedAt: 1,
        updatedAt: 1,
      },
    ],
    translationPrompts: [
      { id: 'prompt-a', name: 'Prompt', systemPrompt: 'Translate', addedAt: 1, updatedAt: 1 },
    ],
    globalReadSettings: {
      translationProvider: 'custom:translator-a',
      translateTargetLang: 'ZH-CN',
      sideBarWidth: '250px',
    },
    globalViewSettings: {
      translationProvider: 'custom:translator-a',
      translateTargetLang: 'ZH-CN',
      translationPromptId: 'prompt-a',
      defaultFontSize: 20,
    },
    dictionarySettings: {
      contextTranslatorId: 'translator-a',
      contextSystemPrompt: 'Explain in Chinese',
      contextMaxOutputTokens: 700,
      enabled: true,
    },
  }) as unknown as SystemSettings;

describe('translation settings file records', () => {
  test('local settings edits retain their original clock across in-place updates and backup excludes pairing state', () => {
    const original = settings();
    original.translationFileSync = {
      enabled: true,
      pairingCode: 'private-pairing-code',
      writer: 'desktop',
      connection: 'test',
      records: trackTranslations({}, original, 'desktop', 100),
    };
    useSettingsStore.getState().setSettings(original);
    original.customTranslators![0]!.model = 'edited-in-place';
    useSettingsStore.getState().setSettings(original);
    const records = useSettingsStore.getState().settings.translationFileSync!.records;
    expect((records['translator/translator-a']!.value as { model: string }).model).toBe(
      'edited-in-place',
    );
    expect(records['translator/translator-a']!.at).toBeGreaterThan(100);
    expect(JSON.stringify(sanitizeSettingsForBackup(original))).not.toContain(
      'private-pairing-code',
    );
  });
  test('syncs the explicit translation fields without device paths, DAV credentials or layout', () => {
    const source = settings();
    const remote = trackTranslations({}, source, 'desktop', 100);
    const phone = settings();
    phone.localBooksDir = '/phone/books';
    phone.globalViewSettings.defaultFontSize = 14;
    phone.globalReadSettings.translateTargetLang = 'EN';
    phone.customTranslators = [];
    const result = applyTranslations(phone, remote);
    expect(result.customTranslators?.[0]?.apiKey).toBe('test-api-key');
    expect(result.globalReadSettings.translateTargetLang).toBe('ZH-CN');
    expect(result.globalViewSettings.translationPromptId).toBe('prompt-a');
    expect(result.localBooksDir).toBe('/phone/books');
    expect(result.globalViewSettings.defaultFontSize).toBe(14);
    expect(JSON.stringify(remote)).not.toContain('local-dav-password');
    expect(JSON.stringify(remote)).not.toContain('/device/books');
  });

  test('records deletions, including when the store no longer persists a tombstone', () => {
    const source = settings();
    const initial = trackTranslations({}, source, 'desktop', 100);
    source.customTranslators = [];
    source.translationPrompts = [];
    const deleted = trackTranslations(initial, source, 'desktop', 200);
    const merged = mergeTranslations(initial, deleted);
    expect(applyTranslations(settings(), merged).customTranslators).toEqual([]);
    expect(applyTranslations(settings(), merged).translationPrompts).toEqual([]);
    expect(mergeTranslations(deleted, initial)).toEqual(merged);
  });

  test('independent edits converge without a stale peer overwriting newer values', () => {
    const original = settings();
    const initial = trackTranslations({}, original, 'desktop', 100);
    const desktop = structuredClone(original);
    desktop.customTranslators![0]!.model = 'model-b';
    const phone = structuredClone(original);
    phone.globalReadSettings.translateTargetLang = 'JA';
    const left = trackTranslations(initial, desktop, 'desktop', 200);
    const right = trackTranslations(initial, phone, 'phone', 210);
    const merged = mergeTranslations(left, right);
    expect(mergeTranslations(right, left)).toEqual(merged);
    const result = applyTranslations(original, merged);
    expect(result.customTranslators?.[0]?.model).toBe('model-b');
    expect(result.globalReadSettings.translateTargetLang).toBe('JA');
    expect(trackTranslations(merged, result, 'desktop', 999)).toEqual(merged);
  });

  test('clearing an optional prompt propagates and same-time conflicts have a stable winner', () => {
    const original = settings();
    const initial = trackTranslations({}, original, 'desktop', 100);
    const leftSettings = structuredClone(original);
    delete leftSettings.dictionarySettings.contextSystemPrompt;
    const rightSettings = structuredClone(original);
    rightSettings.dictionarySettings.contextSystemPrompt = 'Another prompt';
    const left = trackTranslations(initial, leftSettings, 'z-device', 200);
    const right = trackTranslations(initial, rightSettings, 'a-device', 200);
    const merged = mergeTranslations(left, right);
    expect(mergeTranslations(right, left)).toEqual(merged);
    expect(
      applyTranslations(original, merged).dictionarySettings.contextSystemPrompt,
    ).toBeUndefined();
  });

  test('an unrelated settings save does not create new translation edits', () => {
    const original = settings();
    const initial = trackTranslations({}, original, 'desktop', 100);
    original.localBooksDir = '/another/path';
    expect(trackTranslations(initial, original, 'desktop', 200)).toBe(initial);
    expect(Object.keys(snapshotTranslations(original)).length).toBeGreaterThan(5);
  });
});
