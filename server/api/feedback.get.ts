import { resolveFeedbackConfig } from '~core/api/feedback'

/**
 * GET /api/feedback — включён ли канал отзывов. Нужен, чтобы интерфейс не показывал кнопки, которые
 * заведомо приведут к 503: канал включается только когда владелец задал токен и ПРИВАТНЫЙ
 * репозиторий-приёмник (см. `resolveFeedbackConfig`, fail-closed).
 *
 * Наружу отдаём ровно один булев флаг — ни репозитория, ни намёка на настройки.
 */
export default defineEventHandler(() => ({ enabled: resolveFeedbackConfig() !== null }))
