/**
 * BP manifest integrity + freshness tracking.
 *
 * Split into ./integrity/ (W6d F3): signature-loader, gpg-verify,
 * manifest-check, strict-mode-enforcer, barrel. This top-level file is
 * a thin re-export so the existing `./integrity.js` import surface keeps
 * working.
 */

export * from "./integrity/barrel.js";
