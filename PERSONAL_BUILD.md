# Readest Personal

Personal Windows x64 and Android arm64 builds using Readest's existing
self-hosted feature switch. Custom OpenAI-compatible translators and WebDAV/S3
sync are available without a subscription or login.

- Application ID: `com.sunwardgrace.readest`.
- Display name: **Readest Personal**.
- Official automatic updates are disabled. Install future personal builds manually.
- Android uses a persistent personal signing key. Keep a private backup of the
  keystore and its password; replacing it prevents upgrades over previous builds.
- The separate application ID keeps the default data directory separate from
  the official app. Import/export or WebDAV can transfer books between them.
- Official OAuth/app links and the Windows Explorer thumbnail installer hooks
  are not registered by this build. WebDAV, S3 and custom translators do not
  require those integrations.

## Build and download

Push code to the `personal` branch or run **Build Readest Personal** from Actions.
Download `Readest-Personal-Windows-x64` and `Readest-Personal-Android-arm64` from
the successful run's artifacts. They expire after 30 days; keep the installers.
The workflow uses standard GitHub-hosted runners and does not publish a release.

The repository needs two Actions secrets:

| Secret | Content |
| --- | --- |
| `PERSONAL_ANDROID_KEYSTORE_BASE64` | Base64-encoded JKS keystore, alias `readest-personal` |
| `PERSONAL_ANDROID_KEYSTORE_PASSWORD` | Password for both the store and private key |

`scripts/prepare-personal-build.mjs` runs only in the build checkout. It enables
`NEXT_PUBLIC_SELF_HOSTED=true` and `NEXT_PUBLIC_DISABLE_UPDATER=true`, configures
the application identity, and relocates the Android activities to match the
Rust JNI package. Run it after Android initialization and restoration of the
tracked native customizations. It modifies generated and tracked configuration
in that checkout; do not commit those generated changes.

## Configure services

In **Settings → Language → Custom Translators**, add an OpenAI-compatible
provider, enter the service base URL ending in `/v1`, API key and model name,
and test it. Select the saved translator for reading.

In **Settings → Integrations → WebDAV**, enter the server URL, username,
password and a dedicated root path. On both devices, enable book file uploads,
reading progress and notes, then run synchronization. Use the same server and
root on both devices.

WebDAV sync covers the library, book files, reading progress and notes. It does
not replace all account-level synchronization: global settings, reading
statistics, dictionaries/fonts and translator configuration need separate
configuration or backup. No Readest Cloud account is needed for this setup.

Service addresses, API keys, WebDAV passwords and signing keys belong outside
Git. A service reachable only over Tailscale requires Tailscale on each device.

## Track upstream

Keep the official repository as the upstream remote. Merge a chosen upstream
release into `personal`, resolve any conflicts in these build files, and push.
The build uses the checked-out source; it does not silently fetch a newer
Readest release. Review the generated identity and access settings when
upgrading.

Readest's AGPL-3.0 license continues to apply; retain the license and provide
the corresponding source when distributing builds.
