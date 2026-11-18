import { create } from 'zustand';
import type { EnvConfigType } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';
import type { TranslationFileSyncSettings } from '@/types/translation';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomTranslatorStore } from '@/store/customTranslatorStore';
import { useReaderStore } from '@/store/readerStore';
import { getActiveFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import { createFileSyncProvider } from './providerRegistry';
import { normalizeRoot } from './layout';
import { applyTranslations, mergeTranslations, trackTranslations } from './translationSettings';
import { exchangeTranslations, newTranslationPairingCode } from './translationTransport';

export const useTranslationSyncStatus = create<{
  busy: boolean;
  failed: boolean;
}>(() => ({ busy: false, failed: false }));

/** A changed destination must be paired deliberately, not seeded with old credentials. */
export const translationConnection = (settings: SystemSettings): string =>
  JSON.stringify([
    settings.webdav?.serverUrl?.replace(/\/+$/, ''),
    settings.webdav?.username,
    normalizeRoot(settings.webdav?.rootPath),
  ]);

const samePairing = (a?: TranslationFileSyncSettings, b?: TranslationFileSyncSettings) =>
  !!a &&
  !!b &&
  a.pairingCode === b.pairingCode &&
  a.writer === b.writer &&
  a.connection === b.connection;

const hydrate = (settings: SystemSettings) => {
  useCustomTranslatorStore.setState({
    translators: settings.customTranslators ?? [],
    prompts: settings.translationPrompts ?? [],
    loaded: true,
  });
  const defaults = {
    translationProvider: settings.globalViewSettings.translationProvider,
    translateTargetLang: settings.globalViewSettings.translateTargetLang,
    translationPromptId: settings.globalViewSettings.translationPromptId,
  };
  // Update the live defaults without using setViewSettings, which also stamps
  // the book config's updatedAt and would turn old progress into a new edit.
  useReaderStore.setState((reader) => {
    let viewStates = reader.viewStates;
    for (const key of reader.bookKeys) {
      const state = viewStates[key];
      const view = state?.viewSettings;
      if (!view || view.isGlobal === false) continue;
      if (
        view.translationProvider !== defaults.translationProvider ||
        view.translateTargetLang !== defaults.translateTargetLang ||
        view.translationPromptId !== defaults.translationPromptId
      )
        viewStates = {
          ...viewStates,
          [key]: { ...state!, viewSettings: { ...view, ...defaults } },
        };
    }
    return viewStates === reader.viewStates ? reader : { viewStates };
  });
};

const persist = async (env: EnvConfigType, settings: SystemSettings) => {
  useSettingsStore.getState().setSettings(settings, false);
  hydrate(settings);
  await useSettingsStore.getState().saveSettings(env, settings);
};

/** Used by other desktop windows after a notification with no credentials in it. */
export const reloadTranslationSettings = async (env: EnvConfigType): Promise<void> => {
  const disk = await (await env.getAppService()).loadSettings();
  if (!disk.translationFileSync) return;
  const current = useSettingsStore.getState().settings;
  const sync = disk.translationFileSync;
  const records = samePairing(current.translationFileSync, sync)
    ? mergeTranslations(current.translationFileSync!.records, sync.records)
    : sync.records;
  const next = applyTranslations(current, records);
  next.translationFileSync = { ...sync, records };
  useSettingsStore.getState().setSettings(next, false);
  hydrate(next);
};

const providerFor = async (settings: SystemSettings) => {
  if (!getActiveFileSyncBackends(settings).includes('webdav')) {
    throw new Error('Enable WebDAV before pairing translation settings');
  }
  const provider = await createFileSyncProvider('webdav', settings);
  if (!provider) throw new Error('WebDAV is not available');
  return provider;
};

/** Seed from this device, or adopt the remote configuration with its pairing key. */
export const pairTranslationSettings = async (
  env: EnvConfigType,
  existingCode?: string,
): Promise<void> => {
  if (useTranslationSyncStatus.getState().busy) throw new Error('Translation sync is busy');
  useTranslationSyncStatus.setState({ busy: true, failed: false });
  try {
    const current = useSettingsStore.getState().settings;
    const connection = translationConnection(current);
    const code = existingCode?.trim() || newTranslationPairingCode();
    const writer = crypto.randomUUID();
    const baseline = trackTranslations({}, current, writer, Date.now());
    const initial = existingCode ? {} : baseline;
    const records = await exchangeTranslations(
      await providerFor(current),
      initial,
      code,
      writer,
      existingCode ? 'join' : 'create',
    );
    const latest = useSettingsStore.getState().settings;
    // A user can edit a translator while the network is pending. Carry only
    // those edits forward; unchanged defaults on a joining device get no vote.
    const clock = Object.values(records).reduce(
      (max, entry) => Math.max(max, entry.at + 1),
      Date.now(),
    );
    const changes = trackTranslations(baseline, latest, writer, clock);
    const edited = Object.fromEntries(
      Object.entries(changes).filter(([key, entry]) => entry !== baseline[key]),
    );
    const merged = mergeTranslations(records, edited);
    const sameDestination = translationConnection(latest) === connection;
    const next = sameDestination ? applyTranslations(latest, merged) : { ...latest };
    next.translationFileSync = {
      enabled: sameDestination,
      pairingCode: code,
      writer,
      connection,
      records: merged,
      lastSyncedAt: Date.now(),
    };
    await persist(env, next);
    if (!sameDestination)
      throw new Error('Pair translation settings for this WebDAV destination first');
  } catch (error) {
    useTranslationSyncStatus.setState({ failed: true });
    throw error;
  } finally {
    useTranslationSyncStatus.setState({ busy: false });
  }
};

/** Main window owns automatic exchanges; local changes during I/O are merged again. */
export const runTranslationSettingsSync = async (env: EnvConfigType): Promise<void> => {
  const current = useSettingsStore.getState().settings;
  const sync = current.translationFileSync;
  if (!sync?.enabled || !getActiveFileSyncBackends(current).includes('webdav')) return;
  if (useTranslationSyncStatus.getState().busy) return;
  useTranslationSyncStatus.setState({ busy: true, failed: false });
  try {
    if (sync.connection !== translationConnection(current))
      throw new Error('Pair translation settings for this WebDAV destination first');
    const records = await exchangeTranslations(
      await providerFor(current),
      sync.records,
      sync.pairingCode,
      sync.writer,
      'sync',
    );
    const latest = useSettingsStore.getState().settings;
    if (
      !samePairing(latest.translationFileSync, sync) ||
      !latest.translationFileSync?.enabled ||
      translationConnection(latest) !== sync.connection
    )
      return;
    const merged = mergeTranslations(records, latest.translationFileSync.records);
    const next = applyTranslations(latest, merged);
    next.translationFileSync = {
      ...latest.translationFileSync,
      records: merged,
      lastSyncedAt: Date.now(),
    };
    await persist(env, next);
  } catch (error) {
    useTranslationSyncStatus.setState({ failed: true });
    throw error;
  } finally {
    useTranslationSyncStatus.setState({ busy: false });
  }
};
