// Поиск предустановленного Chromium для Playwright (общий для make-og.mjs и make-icons.mjs).
//
// Версия npm-пакета `playwright` может не совпадать со сборкой Chromium, уже лежащей в окружении,
// поэтому указываем на существующую сборку вместо того, чтобы тянуть новую. Возвращает undefined,
// если предустановленной сборки нет — тогда Playwright разрешает путь сам.
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function resolveChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base || !existsSync(base)) return undefined
  const builds = (await readdir(base))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds) {
    const bin = join(base, build, 'chrome-linux', 'chrome')
    if (existsSync(bin)) return bin
  }
  return undefined
}
