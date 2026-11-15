#!/usr/bin/env node
// Run in a disposable build checkout after `tauri android init`, if building Android.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const officialId = 'com.bilingify.readest';
const personalId = 'com.sunwardgrace.readest';

export function preparePersonalBuild(root) {
  const app = path.join(root, 'apps/readest-app');
  const tauri = path.join(app, 'src-tauri');
  const configPath = path.join(tauri, 'tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (![officialId, personalId].includes(config.identifier)) {
    throw new Error(`Unexpected application identifier: ${config.identifier}`);
  }
  config.identifier = personalId;
  config.productName = 'Readest Personal';
  config.bundle.createUpdaterArtifacts = false;
  // The upstream Explorer extension uses a shared CLSID. A parallel install
  // must not replace or unregister the official installation's extension.
  delete config.bundle.windows.nsis.installerHooks;
  config.plugins.updater.endpoints = [];
  config.plugins['deep-link'] = {
    mobile: [{ scheme: ['readest-personal'], appLink: false }],
    desktop: { schemes: ['readest-personal'] },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // Public build flags only. Never bake service addresses, passwords, API keys
  // or the Android signing key into the frontend or repository.
  fs.writeFileSync(
    path.join(app, '.env.production.local'),
    'NEXT_PUBLIC_SELF_HOSTED=true\nNEXT_PUBLIC_DISABLE_UPDATER=true\n',
  );

  const android = path.join(tauri, 'gen/android/app');
  if (!fs.existsSync(android)) return;
  const rewrite = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['build', '.gradle', '.cxx'].includes(entry.name)) rewrite(filename);
      } else if (/\.(kt|kts|java|xml|pro|properties)$/.test(entry.name)) {
        const source = fs.readFileSync(filename, 'utf8');
        let result = source.replaceAll(officialId, personalId);
        if (entry.name === 'AndroidManifest.xml') {
          // Android init generated app_name before the personal profile was
          // applied. Setting productName alone does not change that resource.
          result = result.replace(
            'android:label="@string/app_name"',
            'android:label="Readest Personal"',
          );
          // Keep file/share intents, but don't claim the official OAuth and
          // app-link URLs. Those integrations need their own OAuth registration.
          result = result.replace(/<intent-filter\b[\s\S]*?<\/intent-filter>/g, (filter) =>
            /android:scheme="(?:readest(?:-onedrive)?|com\.googleusercontent\.[^"]+)"|android:host="web\.readest\.com"/.test(
              filter,
            )
              ? ''
              : filter,
          );
        }
        if (result !== source) fs.writeFileSync(filename, result);
      }
    }
  };
  rewrite(android);

  // Tauri's generated activity and the handwritten activity must live under
  // the same package as the JNI entry points emitted by the Rust build.
  for (const sourceSet of ['main', 'test', 'androidTest']) {
    const java = path.join(android, 'src', sourceSet, 'java');
    const original = path.join(java, 'com/bilingify/readest');
    if (!fs.existsSync(original)) continue;
    const destination = path.join(java, 'com/sunwardgrace/readest');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(original, destination);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePersonalBuild(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('Prepared Readest Personal: self-hosted, independent app ID, manual updates.');
}
