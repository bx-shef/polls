/**
 * Error-tracking для unhandled (#5): глобальные обработчики
 * `unhandledRejection`/`uncaughtException` → структурный лог + опциональный
 * `onFatal` (сюда слой деплоя вешает Sentry-захват). OPT-IN: модуль не вешает
 * хендлеры как сайд-эффект импорта (библиотека не должна трогать глобальный
 * `process` молча) — `installProcessHandlers` зовётся явно из `serve`/деплоя.
 */
import { errInfo, type Logger } from './logger'

type FatalKind = 'unhandledRejection' | 'uncaughtException'

/** Минимум `process`, нужный хендлерам (чтобы тесты инжектировали фейк). */
export interface ProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown
  exit?(code: number): never
}

export interface ProcessHandlerOptions {
  logger: Logger
  /** Хук в трекер (Sentry/аналог): получает вид сбоя и причину. */
  onFatal?: (kind: FatalKind, err: unknown) => void
  /**
   * Завершать процесс при `uncaughtException` (best practice — состояние
   * процесса после него неопределённо). Default `true`. `unhandledRejection`
   * процесс НЕ валит — только логируется (поведение Node по умолчанию мягче).
   */
  exitOnUncaught?: boolean
  /** Инжекция `process` в тестах. Default: глобальный `process`. */
  process?: ProcessLike
}

function globalProcess(): ProcessLike | undefined {
  return (globalThis as unknown as { process?: ProcessLike }).process
}

/**
 * Регистрирует обработчики необработанных ошибок процесса. Идемпотентность —
 * на совести вызывающего (зовите один раз на старте). Без `process` (не-node
 * рантайм) — тихий no-op.
 */
export function installProcessHandlers(opts: ProcessHandlerOptions): void {
  const proc = opts.process ?? globalProcess()
  if (!proc) return
  const { logger, onFatal } = opts
  const exitOnUncaught = opts.exitOnUncaught ?? true

  proc.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { err: errInfo(reason) })
    onFatal?.('unhandledRejection', reason)
  })

  proc.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { err: errInfo(err) })
    onFatal?.('uncaughtException', err)
    if (exitOnUncaught && proc.exit) proc.exit(1)
  })
}
