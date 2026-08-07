import { resolveFeedbackConfig } from '~core/api/feedback'

/**
 * GET /api/feedback — включён ли канал отзывов. Нужен, чтобы интерфейс не показывал кнопки, которые
 * заведомо приведут к 503: канал включается, только когда владелец задал ОБЕ переменные — токен и
 * репозиторий-приёмник (см. `resolveFeedbackConfig`, fail-closed; приватность приёмника — на владельце).
 *
 * Наружу отдаём ровно один булев флаг — ни репозитория, ни намёка на настройки.
 */
export default defineEventHandler(() => ({ enabled: resolveFeedbackConfig() !== null }))
