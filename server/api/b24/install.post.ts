// POST /api/b24/install — установка приложения на портал Bitrix24 (#17). Портал шлёт событие
// ONAPPINSTALL с полным набором токенов (`auth`) + `application_token`. Конвейер (всё в ядре):
// parseInstallEvent → handleInstall(сохранить токены `PortalTokenStore` → зарегистрировать робот+
// плейсменты `B24OAuth`). Fail-closed: без конфига приложения/БД/ключа шифрования → 503; битый POST → 400.
//
// Тонкая h3-обёртка. Точный декод тела (form-urlencoded с вложенным `auth[...]`) сверяется на первом
// живом хите портала — h3 readBody парсит JSON и form одинаково в плоский/вложенный объект.
import { parseInstallEvent, installToB24Params, handleInstall } from '~core/bitrix24/install'
import { b24AppConfig, usePortalTokenStore, registerIntegrations } from '../../utils/portal'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ev = parseInstallEvent(body)
  if (!ev) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректное событие установки' }
  }

  const cfg = b24AppConfig()
  const tokenStore = await usePortalTokenStore()
  if (!cfg || !tokenStore) {
    // Не сконфигурировано (NUXT_B24_CLIENT_ID/SECRET, NUXT_BITRIX_TOKEN_KEY, DATABASE_URL, DOMAIN).
    setResponseStatus(event, 503)
    return { ok: false, error: 'Интеграция Bitrix24 не сконфигурирована' }
  }

  try {
    await handleInstall(ev, {
      saveTokens: (tokens) => tokenStore.save(tokens),
      registerIntegrations: () => registerIntegrations(installToB24Params(ev), cfg)
    })
    return { ok: true }
  } catch {
    // Причину наружу не раскрываем; детали — в структурном логе слоя.
    setResponseStatus(event, 502)
    return { ok: false, error: 'Установка не завершена' }
  }
})
