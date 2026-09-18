import { isDatabaseConfigured } from '../db/client'
import { assertEncryptionKey } from './crypto'
import { b24ClientId, b24ClientSecret } from './env'

/**
 * Which pieces of configuration an install needs, and which of them are missing.
 *
 * ⚠ Появилось после первой живой установки на тестовом портале. Мастер честно показал
 * «попробуйте через несколько минут», роут ответил 503 `Not configured`, и в этом месте
 * расследование встало: и роут события, и роут мастера проверяли четыре условия одним
 * `if`, а в журнал писали строку «нет B24_CLIENT_ID/B24_CLIENT_SECRET, DATABASE_URL или
 * B24_TOKEN_ENC_KEY» — перечисление всех причин сразу, то есть не диагноз, а список
 * подозреваемых. Владелец не мог узнать, какую переменную чинить, не подбирая.
 *
 * Здесь то же условие, но с именем виновника. Имена переменных — не секрет: пара приложения
 * и ключ шифрования описаны в `.env.example` и `deploy/README.md`. Секрет — значения, и их
 * тут нет ни в одном виде, даже длиной: длина ключа сужает перебор.
 *
 * ⚠ Один источник на оба роута установки и на `/api/health` намеренно. Две копии условия
 * «готовы ли мы принять установку» со временем начинают проверять разное, и расходятся
 * они молча — health показывает `ok`, установка отвечает 503.
 */

/**
 * Имя переменной окружения так, как её видит процесс.
 *
 * ⚠ Для первых трёх это же и имя строки в `.env` на хосте. Для `DATABASE_URL` — нет:
 * на проде её собирает `deploy/compose.yaml` из `POSTGRES_PASSWORD`, и в `.env` такой
 * строки не существует вовсе. Оператор, пошедший править `DATABASE_URL` в `.env`,
 * не найдёт её и решит, что сломано что-то другое. Нашла панель ревью PR #28.
 */
export type RequiredSetting = 'B24_CLIENT_ID' | 'B24_CLIENT_SECRET' | 'B24_TOKEN_ENC_KEY' | 'DATABASE_URL'

export interface ReadinessProbe {
  clientId: string
  clientSecret: string
  /** Ключ не просто задан, а разворачивается в 32 байта: заглушка задана, но непригодна. */
  encryptionKeyUsable: boolean
  databaseConfigured: boolean
}

/**
 * Чего не хватает, по именам.
 *
 * Чистая функция от снимка окружения, а не от `process.env`: так она проверяется вызовом,
 * без подмены глобального состояния, от которой тесты начинают зависеть друг от друга.
 *
 * Порядок фиксирован: сначала то, что правят руками в `.env`, потом то, что собирается само.
 * Журнал и `/api/health` читает человек, и «всегда в одном порядке» здесь дороже алфавита.
 * ⚠ Первая редакция обещала «порядок как в `.env.example`», и это было неправдой:
 * там `DATABASE_URL` стоит первой строкой. Ложное обещание в комментарии хуже отсутствия
 * обещания — на него начинают опираться. Нашла панель ревью PR #28.
 */
export function missingSettings(probe: ReadinessProbe): RequiredSetting[] {
  const missing: RequiredSetting[] = []
  if (probe.clientId.trim() === '') missing.push('B24_CLIENT_ID')
  if (probe.clientSecret.trim() === '') missing.push('B24_CLIENT_SECRET')
  if (!probe.encryptionKeyUsable) missing.push('B24_TOKEN_ENC_KEY')
  if (!probe.databaseConfigured) missing.push('DATABASE_URL')
  return missing
}

/**
 * То же, но по реальному окружению процесса.
 *
 * ⚠ Не кэшируем. Значение спрашивают редко — дважды за установку и раз на пробу здоровья, —
 * а закэшированный ответ пережил бы правку `.env` и перезапуск контейнера в пределах одного
 * процесса и врал бы оператору ровно тогда, когда тот чинит конфигурацию.
 */
export function missingForInstall(): RequiredSetting[] {
  return missingSettings({
    clientId: b24ClientId(),
    clientSecret: b24ClientSecret(),
    encryptionKeyUsable: assertEncryptionKey(),
    databaseConfigured: isDatabaseConfigured(),
  })
}
