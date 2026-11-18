import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import type { SystemSettings } from '@/types/settings';
import { FakeFileSyncProvider } from '../services/sync/bookData/fakeFileSyncProvider';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTranslatorStore } from '@/store/customTranslatorStore';
import { useTranslationSyncStatus } from '@/services/sync/file/runTranslationSync';
import TranslationSyncSection from '@/components/settings/integrations/TranslationSyncSection';
import '@/styles/globals.css';

const harness = vi.hoisted(() => ({
  provider: null as unknown,
  saved: vi.fn(async () => {}),
}));
vi.mock('@/context/EnvContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/context/EnvContext')>()),
  useEnv: () => ({ envConfig: { getAppService: async () => ({ saveSettings: harness.saved }) } }),
}));
vi.mock('@/hooks/useTranslation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useTranslation')>()),
  useTranslation: () => (text: string) => text,
}));
vi.mock('@/utils/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/clipboard')>()),
  writeTextToClipboard: vi.fn(async () => true),
}));
vi.mock('@/utils/settingsSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/settingsSync')>()),
  broadcastGlobalSettings: vi.fn(),
}));
vi.mock('@/services/sync/file/providerRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sync/file/providerRegistry')>()),
  createFileSyncProvider: async () => harness.provider,
}));
vi.mock('@/services/sync/cloudSyncProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sync/cloudSyncProvider')>()),
  getActiveFileSyncBackends: (settings: SystemSettings) =>
    settings.webdav?.enabled ? ['webdav'] : [],
}));

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
        id: 'translator',
        name: 'My translator',
        type: 'openai-compatible',
        apiKey: 'sample-private-key',
        model: 'sample-model',
        addedAt: 1,
        updatedAt: 1,
      },
    ],
    translationPrompts: [],
    globalReadSettings: { translationProvider: 'custom:translator', translateTargetLang: 'ZH-CN' },
    globalViewSettings: {
      translationProvider: 'custom:translator',
      translateTargetLang: 'ZH-CN',
      defaultFontSize: 20,
    },
    dictionarySettings: { contextTranslatorId: 'translator' },
  }) as unknown as SystemSettings;

beforeEach(() => {
  harness.provider = new FakeFileSyncProvider();
  useSettingsStore.getState().setSettings(settings());
  useTranslationSyncStatus.setState({ busy: false, failed: false });
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-eink');
});

describe('translation pairing controls in Chromium', () => {
  it.each([
    { name: 'desktop light', width: 620, theme: 'light', eink: false, dir: 'ltr' },
    { name: 'phone dark', width: 340, theme: 'dark', eink: false, dir: 'ltr' },
    { name: 'phone RTL e-ink', width: 340, theme: 'light', eink: true, dir: 'rtl' },
  ])('pairs two devices and keeps controls within the panel: $name', async ({
    width,
    theme,
    eink,
    dir,
  }) => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-eink', String(eink));
    const mount = () =>
      render(
        <div dir={dir} style={{ width, padding: 16, boxSizing: 'border-box' }}>
          <TranslationSyncSection />
        </div>,
      );
    let screen = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Start with this device' }));
    await vi.waitFor(() =>
      expect(useSettingsStore.getState().settings.translationFileSync?.enabled).toBe(true),
    );
    const code = useSettingsStore.getState().settings.translationFileSync!.pairingCode;
    const keyInput = screen.getByLabelText('Pairing code') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Show pairing code' }));
    expect(keyInput.type).toBe('text');

    const panel = screen.container.firstElementChild!.getBoundingClientRect();
    for (const control of screen.container.querySelectorAll('button, input')) {
      const box = control.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(panel.left);
      expect(box.right).toBeLessThanOrEqual(panel.right);
    }
    if (eink) expect(getComputedStyle(keyInput).borderTopWidth).toBe('1px');

    cleanup();
    const phone = settings();
    phone.customTranslators = [];
    phone.globalViewSettings.defaultFontSize = 14;
    useSettingsStore.getState().setSettings(phone);
    screen = mount();
    fireEvent.change(screen.getByLabelText('Pairing code from another device'), {
      target: { value: code },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Use settings from another device' }));
    await vi.waitFor(() =>
      expect(useCustomTranslatorStore.getState().translators[0]?.model).toBe('sample-model'),
    );
    expect(useSettingsStore.getState().settings.globalViewSettings.defaultFontSize).toBe(14);
    expect([...(harness.provider as FakeFileSyncProvider).files.values()].join('')).not.toContain(
      'sample-private-key',
    );
    await userEvent.click(screen.getByLabelText('Sync translation settings'));
    await vi.waitFor(() =>
      expect(useSettingsStore.getState().settings.translationFileSync?.enabled).toBe(false),
    );
  });
});
