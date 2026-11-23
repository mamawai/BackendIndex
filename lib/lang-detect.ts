export type Lang = "zh" | "en";

export const LANG_STORAGE_KEY = "bi-lang";

/**
 * Resolve UI language from ordered browser locale tags (`zh*` / `cmn*` -> `"zh"`,
 * `en*` -> `"en"`, other non-Chinese locales -> `"en"`).
 */
export function resolveLangFromLocales(
  locales: readonly (string | null | undefined)[],
  emptyFallback: Lang = "zh"
): Lang {
  const candidates = locales
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);

  for (const code of candidates) {
    if (
      code === "zh" ||
      code.startsWith("zh-") ||
      code.startsWith("zh_") ||
      code === "cmn" ||
      code.startsWith("cmn-")
    ) {
      return "zh";
    }
    if (code === "en" || code.startsWith("en-") || code.startsWith("en_")) {
      return "en";
    }
  }

  return candidates.length > 0 ? "en" : emptyFallback;
}

/** Detect preferred UI language from the browser's `navigator.languages` / `navigator.language`. */
export function detectBrowserLang(): Lang {
  if (typeof navigator === "undefined") return "zh";
  return resolveLangFromLocales([
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ]);
}

/**
 * Resolve active language giving strict priority to an explicit saved override,
 * falling back to ordered browser locale tags when unset or invalid.
 */
export function resolveEffectiveLang(
  savedPreference: string | null | undefined,
  locales: readonly (string | null | undefined)[]
): Lang {
  if (savedPreference === "zh" || savedPreference === "en") {
    return savedPreference;
  }
  return resolveLangFromLocales(locales);
}
