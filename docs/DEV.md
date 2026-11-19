# Working on the Android side

Everything in `src/` can be built and tested in seconds (`npm run dev`, `npm test`, `npm run test:e2e`).
The native half — the Linux shell, the folder picker, the WebView, notifications, the Keystore — needs a
real phone, and until now that meant pushing and waiting four minutes for CI. This is the shorter loop.

## One-time setup (Windows)

The machine needs three things that a fresh install does not have:

1. **JDK 21.** Android Gradle Plugin 8.13 does not accept JDK 25 (it fails with *Unsupported class file
   major version 69*). Keep your system JDK, but pin 21 for Gradle in `%USERPROFILE%\.gradle\gradle.properties`:

   ```
   org.gradle.java.home=C:/Program Files/Eclipse Adoptium/jdk-21.0.13.9-hotspot
   org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
   ```

2. **Android SDK** (command-line tools are enough; no Studio):

   ```powershell
   winget install EclipseAdoptium.Temurin.21.JDK
   # download commandlinetools-win-*_latest.zip from developer.android.com/studio, unpack to
   #   %LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest
   & "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
   & "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
   ```

   Then `android/local.properties` (gitignored) needs one line:
   `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`.

3. **The proot libraries.** `android/app/src/main/jniLibs/arm64-v8a/` is gitignored and CI fills it with
   `scripts/fetch-proot.sh` (which needs bash, `ar` and `patchelf`). On Windows, take the four `.so` out
   of the APK CI already built:

   ```powershell
   pwsh -File scripts/proot-from-apk.ps1        # or -Apk path\to\app-release.apk
   ```

   Without this a local build runs, but the shell reports *"this phone cannot run the built-in Linux"*.

## The loop

```powershell
npx vite build                      # the web app the APK bundles
npx cap sync android                # copies dist/ + generates capacitor.build.gradle
cd android
./gradlew :app:assembleDebug        # ~40 s warm; first run downloads Gradle + AGP
./gradlew :app:installDebug         # needs a phone on adb
```

`npx cap sync android` is the step that bites: without it Gradle fails with
*could not read cordova.variables.gradle*. CI runs it before every build.

## The phone

Wireless debugging (Android 11+) is the difference between a cable and a loop:

```powershell
adb pair 192.168.1.23:41234          # Settings → Developer options → Wireless debugging → Pair with code
adb connect 192.168.1.23:5555
adb devices
```

Then: `adb install -r app\build\outputs\apk\debug\app-debug.apk`, launch the app, and watch what it does:

```powershell
adb logcat -s Capacitor/Console:V ChronicleSelfTest:V AndroidRuntime:E
```

## The device self-test

The native half can be checked without tapping anything, which is what makes it useful to someone
working through an agent or over SSH:

```powershell
adb shell touch /sdcard/Android/data/dev.chronicle.app/files/selftest.key   # once: the key (other apps cannot start the self-test)
adb shell am start -n dev.chronicle.app/.MainActivity --es selftest 1
adb logcat -s ChronicleSelfTest
```

It prints one `PASS`/`FAIL` line per check and ends with a verdict:

```
device   Google Pixel 7, Android 16 (SDK 36), arm64-v8a
PASS abi  arm64-v8a (proot can run)
PASS proot libraries  /data/app/.../lib/arm64
PASS rootfs  /data/user/0/dev.chronicle.app/files/linux/rootfs
PASS shell  Linux 6.1.99-android14 aarch64
PASS toolkit  job, doctor, toolkit-pull in PATH
PASS app -> /workspace  from-app-1f3c9a2b
PASS shell -> app  sha256 4b1d0f2e7c9a3f10 both sides
PASS /phone bind  /data/user/0/.../cache/selftest-phone :/phone
VERDICT ok=9 fail=0 ALL-GOOD
```

The checks are the ones that cost us days: proot actually starting, `/workspace` being the same files on
both sides, and the `-b` mount the phone folder needs. When one fails, the line says what came back.

## What still only runs in CI

The APK workflow (GitHub Actions) is the release path: it fetches proot properly, signs with your
keystore and publishes to the *latest* release. Push to a branch and it builds; you do not need it for
day-to-day work any more.
