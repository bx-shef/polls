import { decideInstallAccess, parsePortalMode } from '~core/bitrix24/portal'

/**
 * Гейт чужой установки (#183) — ИСПОЛНЯЕМОЙ функцией, а не блоком в роуте.
 *
 * ⚠️ Вынесено после мутационного прогона на ревью: пока гейт жил телом роута, его держали только
 * регексы по исходнику, и ТРИ мутации проходили полный `pnpm check` — инверсия условия (свой портал
 * получает 403, чужой ставится), потерянный `return` (403 пишется в лог, а исполнение проваливается
 * дальше и чужой портал сохраняется с ответом 200) и опечатка в имени env-переменной (регекс матчился
 * по префиксу). Здесь всё это ловится исполнением; роуту остаётся вызов и `return` — их держит
 * ужесточённый регекс со смежностью.
 *
 * ⚠️ env передаётся ОБЪЕКТОМ, и функция читает имена сама: опечатка в имени переменной тогда живёт
 * внутри исполняемо покрытого кода, а не в непокрываемом роуте.
 */
export interface InstallGateLog {
  error: (event: string, fields: Record<string, unknown>) => void
}

export type InstallGateVerdict =
  | { verdict: 'allow' }
  | { verdict: 'reject'; status: 403; message: string }

export function installAccessGate(
  memberId: string,
  env: Record<string, string | undefined>,
  log: InstallGateLog
): InstallGateVerdict {
  const expectedRaw = env['B24_EXPECTED_MEMBER_ID']

  // ⚠️ Гейт ИНЕРТЕН (переменная не дошла до контейнера), а установка через него реально проходит —
  // это надо видеть В МОМЕНТ прохода, а не постфактум: env-check читает `.env.prod`, но не
  // доказывает, что контейнер переменную получил (ровно так гейт присвоения #171 не работал на
  // прод-compose при зелёном предполёте). Установок — единицы за жизнь инстанса, шума не будет.
  if (!expectedRaw?.trim() && env['NODE_ENV'] === 'production') {
    log.error('b24_install_gate_inert', {
      memberId,
      msg: 'B24_EXPECTED_MEMBER_ID не задан — установка пропущена БЕЗ гейта частного контура, накопленное присвоит этот портал'
    })
  }

  const access = decideInstallAccess({
    memberId,
    expectedMemberId: expectedRaw,
    mode: parsePortalMode(env['B24_PORTAL_MODE'])
  })
  if (access.allow) return { verdict: 'allow' }
  return { verdict: 'reject', status: 403, message: 'этот сервер обслуживает другой портал Bitrix24' }
}
