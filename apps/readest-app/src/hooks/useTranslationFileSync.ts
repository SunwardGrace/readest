import { useEffect, useMemo } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { debounce } from '@/utils/debounce';
import { isMainAppWindow } from '@/utils/window';
import { runTranslationSettingsSync } from '@/services/sync/file/runTranslationSync';

/** Translation edits sync even while reading; focus/online and polling pull peer edits. */
export const useTranslationFileSync = () => {
  const { envConfig } = useEnv();
  const enabled = useSettingsStore(
    ({ settings }) => !!settings.translationFileSync?.enabled && !!settings.webdav?.enabled,
  );
  // Several settings forms mutate their existing object before setSettings.
  // Select the value here so those edits still notify this hook.
  const records = useSettingsStore(({ settings }) =>
    JSON.stringify(settings.translationFileSync?.records ?? {}),
  );
  const trigger = useMemo(
    () =>
      debounce(() => {
        // The settings panel exposes failures; no private configuration is logged.
        void runTranslationSettingsSync(envConfig).catch(() => {});
      }, 3000),
    [envConfig],
  );

  useEffect(() => {
    if (!enabled || !isMainAppWindow()) return;
    trigger();
  }, [enabled, records, trigger]);

  useEffect(() => {
    if (!enabled || !isMainAppWindow()) return;
    const visible = () => {
      if (!document.hidden) trigger();
    };
    window.addEventListener('focus', visible);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(visible, 60_000);
    return () => {
      window.removeEventListener('focus', visible);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(interval);
      trigger.cancel();
    };
  }, [enabled, trigger]);
};
