import { decryptCiphertext, encryptPlaintext } from '@/libs/crypto/encrypt';
import { ancestorsOf, buildBasePath } from './layout';
import { FileSyncError, type FileSyncProvider } from './provider';
import {
  mergeTranslations,
  parseTranslationRecords,
  type TranslationRecords,
} from './translationSettings';

const PREFIX = 'readest-translations-v1:';
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array => {
  if (!/^(?:[a-f0-9]{2})+$/i.test(text)) throw new Error('Invalid translation sync data');
  return Uint8Array.from(text.match(/../g)!, (byte) => Number.parseInt(byte, 16));
};

/** 256 random bits; this is a pairing key, not a user-chosen password. */
export const newTranslationPairingCode = (): string =>
  PREFIX + hex(crypto.getRandomValues(new Uint8Array(32)));

const importKey = async (code: string): Promise<CryptoKey> => {
  const value = code.trim();
  if (!value.startsWith(PREFIX) || !/^[a-f0-9]{64}$/i.test(value.slice(PREFIX.length))) {
    throw new Error('Invalid translation pairing code');
  }
  return crypto.subtle.importKey(
    'raw',
    unhex(value.slice(PREFIX.length)) as BufferSource,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
};

export const encryptTranslations = async (
  records: TranslationRecords,
  code: string,
): Promise<string> => {
  parseTranslationRecords(records);
  const encrypted = await encryptPlaintext(
    enc.encode(JSON.stringify(records)),
    await importKey(code),
  );
  return JSON.stringify({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: hex(encrypted.iv),
    data: hex(encrypted.ciphertext),
  });
};

export const decryptTranslations = async (
  text: string,
  code: string,
): Promise<TranslationRecords> => {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('Invalid translation sync document');
  const envelope = raw as Record<string, unknown>;
  if (
    envelope['version'] !== 1 ||
    envelope['algorithm'] !== 'AES-256-GCM' ||
    typeof envelope['iv'] !== 'string' ||
    envelope['iv'].length !== 24 ||
    typeof envelope['data'] !== 'string'
  )
    throw new Error('Invalid translation sync document');
  const bytes = await decryptCiphertext(
    {
      iv: unhex(envelope['iv']),
      ciphertext: unhex(envelope['data']),
    },
    await importKey(code),
  );
  return parseTranslationRecords(JSON.parse(dec.decode(bytes)));
};

/** Per-device files avoid read/modify/write clobbers between concurrent peers. */
export const exchangeTranslations = async (
  provider: FileSyncProvider,
  records: TranslationRecords,
  code: string,
  writer: string,
  mode: 'create' | 'join' | 'sync',
): Promise<TranslationRecords> => {
  if (!/^[a-zA-Z0-9_-]+$/.test(writer)) throw new Error('Invalid translation sync device');
  await importKey(code);
  const directory = `${buildBasePath(provider.rootPath)}/translation-settings-v1`;
  const entries = await provider.list(directory).catch((error: unknown) => {
    if (error instanceof FileSyncError && error.code === 'NOT_FOUND') return [];
    throw error;
  });
  const files = entries.filter(
    (entry) => !entry.isDirectory && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name),
  );
  if (mode === 'create' && files.length)
    throw new Error('Translation sync already exists. Use its pairing code.');
  if (mode === 'join' && !files.length)
    throw new Error('No translation sync found. Start on your other device first.');
  let merged = mode === 'join' ? {} : records;
  for (const file of files) {
    // Build from the validated name, never a server-supplied absolute path.
    const text = await provider.readText(`${directory}/${file.name}`);
    if (text === null) throw new Error('Translation sync changed during download. Try again.');
    merged = mergeTranslations(merged, await decryptTranslations(text, code));
  }
  const path = `${directory}/${writer}.json`;
  const encrypted = await encryptTranslations(merged, code);
  await provider.ensureDir(ancestorsOf(path));
  await provider.writeText(path, encrypted, 'application/json');
  return merged;
};
