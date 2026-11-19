// Installing a package in the app's Linux, whichever it is (decision 190): Debian (apt-get) for new installs, Alpine
// (apk) for one installed before. The package names differ between the two, so each call names both.

/**
 * A shell snippet that installs packages: apt-get on Debian (its package lists fetched first when there are none
 * yet), apk on Alpine. Output goes nowhere unless `loud`. → the snippet (exit status 0 when it worked)
 */
export function pkgInstall({ apt, apk }, { loud = false } = {}) {
  const q = loud ? '' : ' >/dev/null 2>&1';
  const debian = `{ ls /var/lib/apt/lists/*_Packages >/dev/null 2>&1 || apt-get update -q${q}; } && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${apt}${q}`;
  return `{ if command -v apt-get >/dev/null 2>&1; then ${debian}; else apk add --no-cache ${apk}${q}; fi; }`;
}

/** `command -v <cmd> || install` – installs only what is missing. */
export const ensureCmd = (cmd, pkgs, opts) => `{ command -v ${cmd} >/dev/null 2>&1 || ${pkgInstall(pkgs, opts)}; }`;
