// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { FakeFileSyncProvider } from '../bookData/fakeFileSyncProvider';
import { FileSyncError } from '@/services/sync/file/provider';
import {
  decryptTranslations,
  encryptTranslations,
  exchangeTranslations,
  newTranslationPairingCode,
} from '@/services/sync/file/translationTransport';
import {
  mergeTranslations,
  type TranslationRecords,
} from '@/services/sync/file/translationSettings';

const data: TranslationRecords = {
  'translator/a': {
    at: 1,
    writer: 'desktop',
    value: {
      id: 'a',
      name: 'Private translator',
      type: 'openai-compatible',
      apiKey: 'private-test-api-key',
      addedAt: 1,
      updatedAt: 1,
    },
  },
};

describe('encrypted translation file transport', () => {
  test('encrypts the entire configuration with a fresh nonce and authenticates it', async () => {
    const code = newTranslationPairingCode();
    const first = await encryptTranslations(data, code);
    const second = await encryptTranslations(data, code);
    expect(first).not.toContain('private-test-api-key');
    expect(first).not.toContain('Private translator');
    expect(first).not.toContain(code);
    expect(second).not.toBe(first);
    expect(await decryptTranslations(first, code)).toEqual(data);
    await expect(decryptTranslations(first, newTranslationPairingCode())).rejects.toThrow();
    const corrupt = JSON.parse(first) as Record<string, unknown>;
    corrupt['data'] = 'AAAA';
    await expect(decryptTranslations(JSON.stringify(corrupt), code)).rejects.toThrow();
  });

  test('a new device adopts the existing records; a wrong key never overwrites remote data', async () => {
    const provider = new FakeFileSyncProvider();
    const code = newTranslationPairingCode();
    await exchangeTranslations(provider, data, code, 'desktop', 'create');
    const saved = new Map(provider.files);
    await expect(
      exchangeTranslations(provider, {}, newTranslationPairingCode(), 'phone', 'join'),
    ).rejects.toThrow();
    expect(provider.files).toEqual(saved);
    expect(await exchangeTranslations(provider, {}, code, 'phone', 'join')).toEqual(data);
    expect([...provider.files.values()].join('')).not.toContain('private-test-api-key');
  });

  test('each device writes its own document and concurrent independent edits converge', async () => {
    const provider = new FakeFileSyncProvider();
    const code = newTranslationPairingCode();
    await exchangeTranslations(provider, data, code, 'desktop', 'create');
    const left = { ...data, 'read/translateTargetLang': { at: 2, writer: 'desktop', value: 'JA' } };
    const right = {
      ...data,
      'view/translateTargetLang': { at: 3, writer: 'phone', value: 'ZH-CN' },
    };
    await Promise.all([
      exchangeTranslations(provider, left, code, 'desktop', 'sync'),
      exchangeTranslations(provider, right, code, 'phone', 'sync'),
    ]);
    expect(provider.files.size).toBe(2);
    const result = await exchangeTranslations(provider, left, code, 'desktop', 'sync');
    expect(result).toEqual(mergeTranslations(left, right));
  });

  test('does not treat authentication/network failure or malformed data as an empty remote', async () => {
    const provider = new FakeFileSyncProvider();
    const code = newTranslationPairingCode();
    provider.listError = new FileSyncError('denied', 'AUTH_FAILED');
    await expect(exchangeTranslations(provider, data, code, 'desktop', 'create')).rejects.toThrow();
    expect(provider.files.size).toBe(0);
    provider.listError = null;
    await expect(exchangeTranslations(provider, {}, code, 'phone', 'join')).rejects.toThrow();
    await exchangeTranslations(provider, data, code, 'desktop', 'create');
    const path = [...provider.files.keys()][0]!;
    provider.files.set(path, 'invalid json');
    const saved = new Map(provider.files);
    await expect(exchangeTranslations(provider, data, code, 'phone', 'sync')).rejects.toThrow();
    expect(provider.files).toEqual(saved);
  });
});
