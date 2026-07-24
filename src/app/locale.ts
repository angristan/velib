export type AppLocale = "fr" | "en"

export const localeTag = (locale: AppLocale): "fr-FR" | "en-GB" =>
  locale === "fr" ? "fr-FR" : "en-GB"

export const normalizeLocale = (value: string | null | undefined): AppLocale | null => {
  if (value === null || value === undefined) return null
  const language = value.trim().toLowerCase().split(/[-_]/)[0]
  if (language === "fr" || language === "en") return language
  return null
}
