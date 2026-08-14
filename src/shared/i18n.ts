export type I18nSubstitutions = string | string[];

export function t(messageName: string, substitutions?: I18nSubstitutions): string {
  const resolvedName = messageName === 'openManager' ? 'download' : messageName;
  const message = substitutions === undefined
    ? chrome.i18n.getMessage(resolvedName)
    : chrome.i18n.getMessage(resolvedName, substitutions);

  return message || resolvedName;
}

export function initDocumentLocale(): void {
  const uiLanguage = chrome.i18n.getUILanguage();
  document.documentElement.lang = uiLanguage.replace('_', '-');
}

export function formatLocalizedNumber(value: number): string {
  return new Intl.NumberFormat(chrome.i18n.getUILanguage().replace('_', '-')).format(value);
}
