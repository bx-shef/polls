import { installProcessHandlers } from '~core/obs/process'
import { logger } from '../utils/api'

/**
 * Nitro-плагин: глобальные обработчики `unhandledRejection`/`uncaughtException` (ядро `installProcessHandlers`,
 * #5/#15). Раньше подключались только в демо-сервере (`scripts/serve.ts`), а прод-Nitro шёл без них —
 * необработанное отклонение промиса молча терялось, а событие `'error'` от pg-пула без слушателя роняло
 * процесс с невнятным трейсом. Здесь ставим структурный лог (и точку для Sentry через `onFatal` в будущем).
 * SERVER-ONLY.
 */
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  installProcessHandlers({ logger })
})
