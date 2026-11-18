import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { mergeSyncedGlobalSettings, subscribeSettingsSync } from '@/utils/settingsSync';
import { useEnv } from '@/context/EnvContext';

/**
 * Adopt global settings broadcast by other app windows (issue #4580). Without
 * this, a window that loaded before another window changed a global setting
 * would clobber that change with its own stale copy on its next save.
 */
export const useSettingsSync = () => {
  const { envConfig } = useEnv();
  useEffect(() => {
    const unlistenPromise = subscribeSettingsSync((payload) => {
      const { settings, setSettings } = useSettingsStore.getState();
      // Settings may not be loaded yet on this window; skip until they are.
      if (!settings.globalViewSettings) return;
      setSettings(
        mergeSyncedGlobalSettings(settings, payload),
        !payload.translationSettingsChanged,
      );
      if (payload.translationSettingsChanged) {
        void import('@/services/sync/file/runTranslationSync')
          .then(({ reloadTranslationSettings }) => reloadTranslationSettings(envConfig))
          .catch(() => {});
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [envConfig]);
};
