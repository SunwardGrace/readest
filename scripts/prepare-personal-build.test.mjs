import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { preparePersonalBuild } from './prepare-personal-build.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readest-personal-test-'));
  temporaryDirectories.push(root);
  const tauri = path.join(root, 'apps/readest-app/src-tauri');
  fs.mkdirSync(tauri, { recursive: true });
  fs.copyFileSync(
    path.join(repo, 'apps/readest-app/src-tauri/tauri.conf.json'),
    path.join(tauri, 'tauri.conf.json'),
  );
  return { root, tauri };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('personal builds isolate app identity, installer hooks and official updates', () => {
  const { root, tauri } = fixture();
  preparePersonalBuild(root);
  const config = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json')));
  assert.equal(config.identifier, 'com.sunwardgrace.readest');
  assert.equal(config.productName, 'Readest Personal');
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.nsis.installerHooks, undefined);
  assert.deepEqual(config.plugins.updater.endpoints, []);
  assert.deepEqual(config.plugins['deep-link'].desktop.schemes, ['readest-personal']);
  const env = fs.readFileSync(path.join(root, 'apps/readest-app/.env.production.local'), 'utf8');
  assert.match(env, /^NEXT_PUBLIC_SELF_HOSTED=true$/m);
  assert.match(env, /^NEXT_PUBLIC_DISABLE_UPDATER=true$/m);
});

test('Android launch identity and JNI package agree while file sharing survives', () => {
  const { root, tauri } = fixture();
  const app = path.join(tauri, 'gen/android/app');
  fs.cpSync(path.join(repo, 'apps/readest-app/src-tauri/gen/android/app'), app, {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(app, 'src/main/java/com/bilingify/readest/TauriActivity.kt'),
    'package com.bilingify.readest\nclass TauriActivity',
  );
  preparePersonalBuild(root);
  preparePersonalBuild(root);
  for (const filename of ['MainActivity.kt', 'TauriActivity.kt']) {
    const source = fs.readFileSync(
      path.join(app, 'src/main/java/com/sunwardgrace/readest', filename),
      'utf8',
    );
    assert.match(source, /^package com.sunwardgrace.readest/m);
  }
  assert.ok(!fs.existsSync(path.join(app, 'src/main/java/com/bilingify/readest')));
  const gradle = fs.readFileSync(path.join(app, 'build.gradle.kts'), 'utf8');
  assert.match(gradle, /namespace = "com.sunwardgrace.readest"/);
  assert.match(gradle, /applicationId = "com.sunwardgrace.readest"/);
  const manifest = fs.readFileSync(path.join(app, 'src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(
    manifest.includes('android:label="Readest Personal"'),
    'The APK must have a distinct launcher name',
  );
  assert.ok(manifest.includes('android.intent.action.SEND'));
  assert.ok(manifest.includes('${applicationId}.fileprovider'));
  assert.ok(!manifest.includes('android:scheme="readest"'));
  assert.ok(!manifest.includes('android:host="web.readest.com"'));
});
