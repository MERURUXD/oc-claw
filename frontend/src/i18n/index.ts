import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './locales/zh.json'
import en from './locales/en.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import { BUBBLE_STATUS_TRANSLATIONS } from './bubbleStatusTranslations'

const supportedLngs = ['zh', 'en', 'ja', 'ko', 'es', 'fr'] as const
type SupportedLng = typeof supportedLngs[number]

// Detect saved language from localStorage, fallback to system language, then 'en'
function detectLanguage(): SupportedLng {
  const saved = localStorage.getItem('oc-claw-lang')
  if (saved && supportedLngs.includes(saved as SupportedLng)) return saved as SupportedLng
  const nav = navigator.language.toLowerCase()
  if (nav.startsWith('zh')) return 'zh'
  if (nav.startsWith('ja')) return 'ja'
  if (nav.startsWith('ko')) return 'ko'
  if (nav.startsWith('es')) return 'es'
  if (nav.startsWith('fr')) return 'fr'
  return 'en'
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: { ...zh, mini: { ...zh.mini, ...BUBBLE_STATUS_TRANSLATIONS.zh } } },
    en: { translation: { ...en, mini: { ...en.mini, ...BUBBLE_STATUS_TRANSLATIONS.en } } },
    ja: { translation: { ...ja, mini: { ...ja.mini, ...BUBBLE_STATUS_TRANSLATIONS.ja } } },
    ko: { translation: { ...ko, mini: { ...ko.mini, ...BUBBLE_STATUS_TRANSLATIONS.ko } } },
    es: { translation: { ...es, mini: { ...es.mini, ...BUBBLE_STATUS_TRANSLATIONS.es } } },
    fr: { translation: { ...fr, mini: { ...fr.mini, ...BUBBLE_STATUS_TRANSLATIONS.fr } } },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n

/** Change language and persist to localStorage */
export function setLanguage(lng: string) {
  i18n.changeLanguage(lng)
  localStorage.setItem('oc-claw-lang', lng)
}
