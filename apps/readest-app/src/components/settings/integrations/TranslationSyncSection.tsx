import { useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { writeTextToClipboard } from '@/utils/clipboard';
import {
  pairTranslationSettings,
  runTranslationSettingsSync,
  translationConnection,
  useTranslationSyncStatus,
} from '@/services/sync/file/runTranslationSync';
import { BoxedList, SectionTitle, SettingsSwitchRow } from '../primitives';

const TranslationSyncSection = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const sync = settings.translationFileSync;
  const { busy, failed } = useTranslationSyncStatus();
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [message, setMessage] = useState('');
  const paired = !!sync && sync.connection === translationConnection(settings);

  const perform = async (action: () => Promise<void>) => {
    setMessage('');
    useTranslationSyncStatus.setState({ failed: false });
    try {
      await action();
      setMessage(
        useSettingsStore.getState().settings.translationFileSync?.enabled
          ? _('Translation settings synced')
          : _('Paused'),
      );
    } catch {
      useTranslationSyncStatus.setState({ failed: true });
      setMessage('');
    }
  };

  const toggle = async () => {
    const latest = useSettingsStore.getState().settings;
    if (!latest.translationFileSync) return;
    const next = {
      ...latest,
      translationFileSync: {
        ...latest.translationFileSync,
        enabled: !latest.translationFileSync.enabled,
      },
    };
    useSettingsStore.getState().setSettings(next);
    await useSettingsStore.getState().saveSettings(envConfig, next);
    if (next.translationFileSync.enabled) await runTranslationSettingsSync(envConfig);
  };

  return (
    <section className='space-y-3'>
      <SectionTitle>{_('Translation settings sync')}</SectionTitle>
      <p className='text-base-content/70 text-sm'>
        {_(
          'Sync translators, API keys, prompts and translation defaults through WebDAV. Configuration is encrypted before upload.',
        )}
      </p>
      {paired ? (
        <>
          <BoxedList>
            <SettingsSwitchRow
              label={_('Sync translation settings')}
              checked={sync.enabled}
              disabled={busy}
              onChange={() => void perform(toggle)}
            />
          </BoxedList>
          <label className='block space-y-1 text-sm'>
            <span>{_('Pairing code')}</span>
            <input
              readOnly
              type={showCode ? 'text' : 'password'}
              value={sync.pairingCode}
              className='input eink-bordered h-11 w-full font-mono text-xs'
              dir='ltr'
              autoComplete='off'
            />
          </label>
          <p className='text-base-content/70 text-sm'>
            {_(
              'Enter this code once on your other device. Keep it private: it unlocks your synced API keys.',
            )}
          </p>
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              className='btn eink-bordered btn-ghost min-h-10 h-auto px-3 py-2'
              onClick={() => setShowCode(!showCode)}
            >
              {showCode ? _('Hide pairing code') : _('Show pairing code')}
            </button>
            <button
              type='button'
              className='btn eink-bordered btn-ghost min-h-10 h-auto px-3 py-2'
              onClick={() =>
                void writeTextToClipboard(sync.pairingCode).then((ok) =>
                  setMessage(ok ? _('Copied to clipboard') : _('Failed to copy')),
                )
              }
            >
              {_('Copy pairing code')}
            </button>
            <button
              type='button'
              className='btn btn-contrast min-h-10 h-auto px-3 py-2'
              disabled={busy || !sync.enabled}
              onClick={() => void perform(() => runTranslationSettingsSync(envConfig))}
            >
              {busy ? _('Syncing…') : _('Sync now')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className='text-base-content/70 text-sm'>
            {_(
              'Start on the device with the settings you want to keep. On other devices, enter its pairing code to adopt those translation settings.',
            )}
          </p>
          <button
            type='button'
            disabled={busy}
            className='btn btn-contrast min-h-10 h-auto px-3 py-2'
            onClick={() => void perform(() => pairTranslationSettings(envConfig))}
          >
            {_('Start with this device')}
          </button>
          <label className='block space-y-1 text-sm'>
            <span>{_('Pairing code from another device')}</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              type='password'
              autoComplete='off'
              spellCheck={false}
              className='input eink-bordered h-11 w-full text-sm'
              dir='ltr'
            />
          </label>
          <button
            type='button'
            disabled={busy || !code.trim()}
            className='btn eink-bordered min-h-10 h-auto px-3 py-2'
            onClick={() => void perform(() => pairTranslationSettings(envConfig, code))}
          >
            {_('Use settings from another device')}
          </button>
        </>
      )}
      {(message || failed) && (
        <p role='status' className='text-base-content/80 text-sm'>
          {failed ? _('Translation sync failed. Check your connection and pairing code.') : message}
        </p>
      )}
    </section>
  );
};

export default TranslationSyncSection;
