# Ensō — native wrapper (Capacitor)

This folder builds the **Android app** for the Play Store. It is a thin native shell
that loads the **live** web app (`https://techtimerdubai.github.io/Enso/`).

**Why it's done this way:** because the shell just loads the live site, **every `git push`
to the web app updates the installed store app automatically** — no rebuild, no
re-submission. You only rebuild this wrapper for _native_ changes (app icon, app name,
Android permissions, or the yearly Android target-SDK bump). See `../PLAY_STORE.md` for
the full end-to-end publishing guide.

## Prerequisites (one time)
- **Android Studio** (includes the Android SDK + a bundled JDK) — https://developer.android.com/studio
- **Node.js** (already installed here).

## Build the Android project
From this `native/` folder:

```bash
npm install
npx cap add android      # generates the android/ project (git-ignored)
npx cap sync
npx cap open android     # opens it in Android Studio
```

Then, in **Android Studio**:
1. Let Gradle finish syncing.
2. **Build → Generate Signed Bundle / APK → Android App Bundle (.aab)**.
3. Create a **new keystore** the first time — **BACK IT UP AND KEEP IT FOREVER.**
   If you lose it you can never update this app again (Google won't accept a new key).
4. Produce the signed **`.aab`** and upload it in the Play Console.

## Config
All wrapper settings live in [`capacitor.config.json`](./capacitor.config.json):
- `appId`: `io.github.techtimerdubai.enso` — the permanent Android package name. **Do not
  change it after the first Play release** (it's the app's identity forever).
- `server.url`: the live site the app loads. Change this only if the app moves to a new URL
  (e.g. a custom domain); then rebuild + upload a new release.

## Updating the app later
- **Content / features / fixes:** edit the web app in the parent folder → `git push`. Live
  on the website AND inside the installed store app within seconds. Nothing to do here.
- **Native shell change** (icon, name, permissions, target-SDK): bump `versionCode`/
  `versionName` in `android/app/build.gradle`, rebuild the `.aab`, upload a new release.

`android/` and `node_modules/` are git-ignored — they regenerate from the commands above.
