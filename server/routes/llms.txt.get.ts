import { buildLlmsTxt } from '~core/client/help'
import { b24AppConfig } from '../utils/portal'

/**
 * `/llms.txt` — индекс документации для ИИ-ассистентов (конвенция llms.txt; тот же паттерн, что у
 * b24ui). Содержимое строит чистая `buildLlmsTxt` из ЕДИНОГО реестра справки — роут только отдаёт
 * текст. База ссылок — домен приложения; без конфига (dev) ссылки относительные.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=3600')
  return buildLlmsTxt(b24AppConfig()?.baseUrl ?? '')
})
