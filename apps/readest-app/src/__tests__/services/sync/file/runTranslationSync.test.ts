// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';
import { FakeFileSyncProvider } from '../bookData/fakeFileSyncProvider';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTranslatorStore } from '@/store/customTranslatorStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import type { ViewSettings } from '@/types/book';
import {
  pairTranslationSettings,
  runTranslationSettingsSync,
  useTranslationSyncStatus,
} from '@/services/sync/file/runTranslationSync';

const harness = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('@/services/sync/file/providerRegistry', () => ({
  createFileSyncProvider: vi.fn(async () => harness.provider),
}));
vi.mock('@/services/sync/cloudSyncProvider', () => ({
  getActiveFileSyncBackends: (settings: SystemSettings) =>
    settings.webdav?.enabled ? ['webdav'] : [],
}));
vi.mock('@/utils/settingsSync', () => ({ broadcastGlobalSettings: vi.fn() }));

const settings = () =>
  ({
    webdav: {
      enabled: true,
      serverUrl: 'https://dav.example.com',
      rootPath: '/',
      username: 'test',
    },
    customTranslators: [
      {
        id: 'a',
        name: 'Translator',
        type: 'openai-compatible',
        model: 'first',
        apiKey: 'test-api-key',
        addedAt: 1,
        updatedAt: 1,
      },
    ],
    translationPrompts: [],
    globalReadSettings: { translationProvider: 'custom:a', translateTargetLang: 'ZH-CN' },
    globalViewSettings: {
      translationProvider: 'custom:a',
      translateTargetLang: 'ZH-CN',
      defaultFontSize: 20,
    },
    dictionarySettings: { contextTranslatorId: 'a', contextSystemPrompt: 'Explain in Chinese' },
  }) as unknown as SystemSettings;
const saveSettings = vi.fn(async (_settings: SystemSettings) => {});
const env = { getAppService: async () => ({ saveSettings }) } as unknown as EnvConfigType;

beforeEach(() => {
  vi.restoreAllMocks();
  useReaderStore.setState({ bookKeys: [], viewStates: {} });
  useBookDataStore.setState({ booksData: {} });
  harness.provider = new FakeFileSyncProvider();
  useSettingsStore.getState().setSettings(settings());
  useTranslationSyncStatus.setState({ busy: false, failed: false });
  saveSettings.mockClear();
});

describe('translation sync application integration', () => {
  test('updates open books using global translation defaults while preserving book overrides', async () => {
    const globalView = {
      isGlobal: true,
      translateTargetLang: 'EN',
      defaultFontSize: 14,
    } as ViewSettings;
    const bookView = {
      isGlobal: false,
      translateTargetLang: 'JA',
      defaultFontSize: 18,
    } as ViewSettings;
    useReaderStore.setState({
      bookKeys: ['global-book', 'override-book'],
      viewStates: {
        'global-book': { viewSettings: globalView, isPrimary: true },
        'override-book': { viewSettings: bookView, isPrimary: true },
      } as unknown as ReturnType<typeof useReaderStore.getState>['viewStates'],
    });
    const config = { updatedAt: 100, location: 'saved-reading-position', viewSettings: globalView };
    useBookDataStore.setState({
      booksData: { global: { config } } as unknown as ReturnType<
        typeof useBookDataStore.getState
      >['booksData'],
    });
    await pairTranslationSettings(env);
    expect(useReaderStore.getState().getViewSettings('global-book')).toMatchObject({
      translateTargetLang: 'ZH-CN',
      defaultFontSize: 14,
    });
    expect(useReaderStore.getState().getViewSettings('override-book')).toBe(bookView);
    expect(
      useBookDataStore.getState().booksData['global']?.config,
      'syncing translation defaults must not stamp reading progress as a new edit',
    ).toBe(config);
  });
  test('pairs a second device, updates the live translator store and saves only translation changes', async () => {
    await pairTranslationSettings(env);
    const desktop = structuredClone(useSettingsStore.getState().settings);
    const code = desktop.translationFileSync!.pairingCode;
    const phone = settings();
    phone.customTranslators = [];
    phone.globalViewSettings.defaultFontSize = 14;
    useSettingsStore.getState().setSettings(phone);
    await pairTranslationSettings(env, code);
    expect(useCustomTranslatorStore.getState().translators[0]?.apiKey).toBe('test-api-key');
    expect(useSettingsStore.getState().settings.globalViewSettings.defaultFontSize).toBe(14);
    expect(saveSettings).toHaveBeenCalled();

    useSettingsStore.getState().setSettings(desktop);
    desktop.customTranslators![0]!.model = 'updated-desktop';
    useSettingsStore.getState().setSettings(desktop);
    await runTranslationSettingsSync(env);
    const updatedDesktop = structuredClone(useSettingsStore.getState().settings);

    useSettingsStore.getState().setSettings(phone);
    await pairTranslationSettings(env, code);
    expect(useCustomTranslatorStore.getState().translators[0]?.model).toBe('updated-desktop');
    expect(updatedDesktop.translationFileSync!.records).toBeDefined();
  });

  test('preserves local edits made during a network exchange and uploads them on the next pass', async () => {
    await pairTranslationSettings(env);
    const provider = harness.provider as FakeFileSyncProvider;
    const originalRead = provider.readText.bind(provider);
    let edited = false;
    provider.readText = async (path) => {
      const text = await originalRead(path);
      if (!edited) {
        edited = true;
        const current = useSettingsStore.getState().settings;
        current.customTranslators![0]!.model = 'edited-during-download';
        useSettingsStore.getState().setSettings(current);
      }
      return text;
    };
    await runTranslationSettingsSync(env);
    expect(useSettingsStore.getState().settings.customTranslators?.[0]?.model).toBe(
      'edited-during-download',
    );
    await runTranslationSettingsSync(env);
    const code = useSettingsStore.getState().settings.translationFileSync!.pairingCode;
    useSettingsStore.getState().setSettings(settings());
    await pairTranslationSettings(env, code);
    expect(useCustomTranslatorStore.getState().translators[0]?.model).toBe(
      'edited-during-download',
    );
  });

  test('paused sync writes nothing and changing the WebDAV destination requires pairing', async () => {
    await pairTranslationSettings(env);
    const provider = harness.provider as FakeFileSyncProvider;
    const current = useSettingsStore.getState().settings;
    const saved = new Map(provider.files);
    current.translationFileSync!.enabled = false;
    await runTranslationSettingsSync(env);
    expect(provider.files).toEqual(saved);
    current.translationFileSync!.enabled = true;
    current.webdav.serverUrl = 'https://another.example.com';
    await expect(runTranslationSettingsSync(env)).rejects.toThrow('Pair translation settings');
    expect(provider.files).toEqual(saved);
  });

  test('joining preserves edits made while the pairing request is in flight', async () => {
    await pairTranslationSettings(env);
    const code = useSettingsStore.getState().settings.translationFileSync!.pairingCode;
    useSettingsStore.getState().setSettings(settings());
    const provider = harness.provider as FakeFileSyncProvider;
    const read = provider.readText.bind(provider);
    provider.readText = async (path) => {
      const text = await read(path);
      const current = useSettingsStore.getState().settings;
      current.globalReadSettings.translateTargetLang = 'JA';
      useSettingsStore.getState().setSettings(current);
      return text;
    };
    await expect(pairTranslationSettings(env, code)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().settings.globalReadSettings.translateTargetLang).toBe('JA');
    expect(useSettingsStore.getState().settings.translationFileSync?.pairingCode).toBe(code);
  });
});
