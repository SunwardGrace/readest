import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslationFileSync } from '@/hooks/useTranslationFileSync';

const mocks = vi.hoisted(() => ({ env: {}, run: vi.fn(async () => {}) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: mocks.env }) }));
vi.mock('@/utils/window', () => ({ isMainAppWindow: () => true }));
vi.mock('@/services/sync/file/runTranslationSync', () => ({
  runTranslationSettingsSync: mocks.run,
}));
afterEach(() => vi.useRealTimers());

test('an in-place translator edit schedules sync without waiting for the periodic pull', async () => {
  vi.useFakeTimers();
  const settings = {
    webdav: { enabled: true },
    customTranslators: [
      { id: 'a', type: 'deepl', name: 'Translator', apiKey: 'old', addedAt: 1, updatedAt: 1 },
    ],
    translationFileSync: {
      enabled: true,
      pairingCode: 'local-test-code',
      writer: 'desktop',
      connection: 'test',
      records: {},
    },
  } as unknown as SystemSettings;
  useSettingsStore.getState().setSettings(settings);
  const hook = renderHook(() => useTranslationFileSync());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  mocks.run.mockClear();
  act(() => {
    settings.customTranslators![0]!.apiKey = 'new';
    useSettingsStore.getState().setSettings(settings);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(mocks.run).toHaveBeenCalledTimes(1);
  hook.unmount();
});
