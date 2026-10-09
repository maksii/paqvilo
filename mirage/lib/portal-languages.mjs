/**
 * Power Pages portal languages: name, language code, LCID and portal display name, as
 * listed under "Supported languages" in Microsoft Learn, "Enable multiple-language
 * website support" (https://learn.microsoft.com/power-pages/configure/enable-multiple-language-support).
 * Exported website language records carry only their name and a portal-language
 * reference, so the URL language code is derived from this catalogue.
 */
export const PORTAL_LANGUAGES = Object.freeze(
  [
    ["Basque - Basque", "eu-ES", 1069, "euskara"],
    ["Bulgarian - Bulgaria", "bg-BG", 1026, "български"],
    ["Catalan - Catalan", "ca-ES", 1027, "català"],
    ["Chinese - China", "zh-CN", 2052, "中文(中国)"],
    ["Chinese - Hong Kong SAR", "zh-HK", 3076, "中文(香港特別行政區)"],
    ["Chinese - Traditional", "zh-TW", 1028, "中文(台灣)"],
    ["Croatian - Croatia", "hr-HR", 1050, "hrvatski"],
    ["Czech - Czech Republic", "cs-CZ", 1029, "čeština"],
    ["Danish - Denmark", "da-DK", 1030, "dansk"],
    ["Dutch - Netherlands", "nl-NL", 1043, "Nederlands"],
    ["English", "en-US", 1033, "English"],
    ["Estonian - Estonia", "et-EE", 1061, "eesti"],
    ["Finnish - Finland", "fi-FI", 1035, "suomi"],
    ["French - France", "fr-FR", 1036, "français"],
    ["Galician - Spain", "gl-ES", 1110, "galego"],
    ["German - Germany", "de-DE", 1031, "Deutsch"],
    ["Greek - Greece", "el-GR", 1032, "Ελληνικά"],
    ["Hindi - India", "hi-IN", 1081, "हिंदी"],
    ["Hungarian - Hungary", "hu-HU", 1038, "magyar"],
    ["Indonesian - Indonesia", "id-ID", 1057, "Bahasa Indonesia"],
    ["Italian - Italy", "it-IT", 1040, "italiano"],
    ["Japanese - Japan", "ja-JP", 1041, "日本語"],
    ["Kazakh - Kazakhstan", "kk-KZ", 1087, "қазақ тілі"],
    ["Korean - Korea", "ko-KR", 1042, "한국어"],
    ["Latvian - Latvia", "lv-LV", 1062, "latviešu"],
    ["Lithuanian - Lithuania", "lt-LT", 1063, "lietuvių"],
    ["Malay - Malaysia", "ms-MY", 1086, "Bahasa Melayu"],
    ["Norwegian (Bokmål) - Norway", "nb-NO", 1044, "norsk bokmål"],
    ["Polish - Poland", "pl-PL", 1045, "polski"],
    ["Portuguese - Brazil", "pt-BR", 1046, "português (Brasil)"],
    ["Portuguese - Portugal", "pt-PT", 2070, "português (Portugal)"],
    ["Romanian - Romania", "ro-RO", 1048, "română"],
    ["Russian - Russia", "ru-RU", 1049, "русский"],
    ["Serbian (Cyrillic) - Serbia", "sr-Cyrl-CS", 3098, "српски"],
    ["Serbian (Latin) - Serbia", "sr-Latn-CS", 2074, "srpski"],
    ["Slovak - Slovakia", "sk-SK", 1051, "slovenčina"],
    ["Slovenian - Slovenia", "sl-SI", 1060, "slovenščina"],
    ["Spanish (Traditional Sort) - Spain", "es-ES", 3082, "español"],
    ["Swedish - Sweden", "sv-SE", 1053, "svenska"],
    ["Thai - Thailand", "th-TH", 1054, "ไทย"],
    ["Turkish - Türkiye", "tr-TR", 1055, "Türkçe"],
    ["Ukrainian - Ukraine", "uk-UA", 1058, "українська"],
    ["Vietnamese - Vietnam", "vi-VN", 1066, "Tiếng Việt"],
  ].map(([name, code, lcid, displayName]) => Object.freeze({ name, code, lcid, displayName })),
);

const key = (value) => String(value ?? "").trim().toLowerCase();

/**
 * The catalogue entry for a website language: by its name (catalogue name, portal
 * display name or language code, case-insensitive), else by LCID.
 */
export function portalLanguage({ name, lcid } = {}) {
  const wanted = key(name);
  if (wanted) {
    const byName = PORTAL_LANGUAGES.find(
      (language) => key(language.name) === wanted || key(language.displayName) === wanted || key(language.code) === wanted,
    );
    if (byName) return byName;
  }
  const number = Number(lcid);
  return Number.isInteger(number) ? (PORTAL_LANGUAGES.find((language) => language.lcid === number) ?? null) : null;
}
