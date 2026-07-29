# Publishing Ensō to the Google Play Store

This is the complete, do-it-once guide. The design goal: **after you publish once, you
never have to touch the store again for normal updates** — editing the web app and running
`git push` updates the installed app automatically.

---

## How updates work (read this first)

Ensō ships as a tiny **native shell (Capacitor)** that loads the **live** web app at
`https://techtimerdubai.github.io/Enso/`. So:

| You want to change… | What you do | Re-submit to Play? |
|---|---|---|
| A feature, a colour, a bug fix, the intro, anything in the app | Edit the web files → `git push` (bump `CACHE` in `sw.js`) | ❌ No — live in seconds, on the website **and** the installed app |
| The **app icon**, **app name**, Android **permissions** | Rebuild the wrapper, upload a new `.aab` | ✅ Yes |
| Android's **yearly target-SDK bump** (Google requires it ~once a year) | Rebuild, upload a new `.aab` | ✅ Yes |

The offline experience is preserved: the app's service worker caches the site on first
run, so it works with no connection after the first successful load.

---

## What's already done ✅

- **Installable PWA**: valid `manifest.webmanifest` (name, id, standalone display, theme
  colours, categories) and a working service worker (`sw.js`, network-first + offline
  fallback).
- **Icons**: `icons/icon-192.png`, `icon-512.png`, `icon-1024.png`, and a **maskable**
  `icon-maskable.png` (Android adaptive icon).
- **Privacy policy**: live at `https://techtimerdubai.github.io/Enso/privacy.html`
  (collects nothing, sends nothing, on-device only — kid-safe / COPPA-friendly).
- **Native wrapper scaffold**: see [`native/`](./native/) + [`native/README.md`](./native/README.md).
- `.nojekyll` added so GitHub Pages serves the files as-is.

## What only you can do (needs your machine / account / payment)

1. Install **Android Studio** (one download; includes the Android SDK + JDK).
2. Create a **Google Play Developer account** — **US$25, one-time** (not yearly).
3. Create and **safely keep** a signing keystore.
4. Provide **store-listing assets** (screenshots, etc. — checklist below).

---

## Step-by-step

### 1) Build the Android App Bundle (`.aab`)
Follow [`native/README.md`](./native/README.md):

```bash
cd native
npm install
npx cap add android
npx cap sync
npx cap open android
```

In Android Studio: **Build → Generate Signed Bundle / APK → Android App Bundle**.

> ⚠️ **The keystore is forever.** Create it once, then back it up in at least two safe
> places (password manager + offline copy). Losing it means you can **never** update this
> app again under the same listing. (Turning on Google **Play App Signing** during upload
> is recommended — it lets Google help recover the upload key, but keep your own copy too.)

### 2) Create the app in the Play Console
- Go to https://play.google.com/console → **Create app**.
- Name: **Ensō**. Type: **App**. Free. Confirm the developer-program policies.

### 3) Fill the listing
- **Full/short description**: reuse the manifest description — "A free infinite-canvas ink
  app. Sumi-e brush, mandala mode, time-lapse replay, personal ink-seal, and one-tap free
  sharing."
- **App icon (512×512)**: `icons/icon-512.png` (or `icon-1024.png` scaled).
- **Feature graphic (1024×500)**: `icons/banner.png` if it fits, otherwise make one.
- **Phone screenshots (2–8, min 320px)**: capture on a real device or emulator — draw
  something, open a magic world, show the flipbook. *(These are the one asset I couldn't
  generate for you; they must be real captures.)*
- **Privacy policy URL**: `https://techtimerdubai.github.io/Enso/privacy.html`
- **Category**: Art & Design (or Productivity). **Tags**: drawing, art, kids.

### 4) Data safety & content rating
- **Data safety form**: *No data collected, no data shared.* (True — CSP `connect-src
  'self'`, everything is on-device.) This is Ensō's biggest trust advantage.
- **Content rating questionnaire**: it's a drawing tool → **Everyone / PEGI 3**.
- Optional: opt into **"Designed for Families"** (Ensō qualifies — no ads, no data, kid-safe).

### 5) Upload & roll out
- **Production → Create new release → upload the `.aab`**.
- Set **release notes**, review, and **submit**. First review typically takes a few days.

---

## Assets checklist

| Asset | Status | Source |
|---|---|---|
| App icon 512×512 | ✅ have | `icons/icon-512.png` |
| Maskable/adaptive icon | ✅ have | `icons/icon-maskable.png` |
| Feature graphic 1024×500 | ⚠️ verify | `icons/banner.png` (check size) |
| Phone screenshots ×2–8 | ❌ you capture | on device/emulator |
| Privacy policy URL | ✅ live | `/privacy.html` |
| Signed `.aab` | ❌ you build | Android Studio (step 1) |

---

## Alternative path: PWABuilder / TWA (no Android Studio)
You can instead go to **https://www.pwabuilder.com**, paste the site URL, and download an
Android package. It uses a **Trusted Web Activity (TWA)**. Caveat for our setup: a TWA
verifies the whole **origin** via a Digital Asset Links file that must live at the origin
root — `https://techtimerdubai.github.io/.well-known/assetlinks.json` — which is a
**separate repo** (`techtimerdubai.github.io`), not this project's `/Enso/` subpath. Without
it the app shows a browser URL bar. Because Ensō lives on a project subpath, the **Capacitor
wrapper above is the simpler, cleaner route** (no asset-links requirement). If you later add
a custom domain, TWA becomes easy and is worth revisiting.

## iOS (later)
Same idea with Capacitor's iOS platform, but it needs a **Mac + Xcode** and the **Apple
Developer Program (US$99/year)**. Do Android first; add iOS when you're ready.

---

*Architecture recap: the store app is a shell around your live site. Keep shipping the web
app the way you already do — the store app just follows along.*
