import { checkEnv, hasEnvIssues } from '~core/obs/env-check'
import { logger } from '../utils/api'

/**
 * Пишет отчёт о проблемах окружения при старте — до первого запроса.
 *
 * Тонкая обёртка: вся логика — чистая `checkEnv` в ядре (под тестами), здесь только чтение окружения
 * и вывод. Процесс НЕ роняем: часть переменных фатальна и без нас, а остальное — осознанный выбор
 * режима, решать за владельца мы не должны. Молчим, когда всё в порядке.
 *
 * В лог идут ИМЕНА переменных и характер проблемы — значения никогда: там секреты.
 */
export default defineNitroPlugin(() => {
  const report = checkEnv(process.env, { isProduction: process.env.NODE_ENV === 'production' })
  if (!hasEnvIssues(report)) return
  for (const issue of report.errors) logger.error('env_problem', { variable: issue.name, detail: issue.message })
  for (const issue of report.warnings) logger.warn('env_notice', { variable: issue.name, detail: issue.message })
})
