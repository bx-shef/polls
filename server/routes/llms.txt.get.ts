import { defineEventHandler, setResponseHeader } from 'h3'
import { buildLlmsTxt } from '../../shared/faq'
import { publicBaseUrl } from '../utils/env'

/**
 * `/llms.txt` — the same help as `/help`, as plain text for the customer's AI assistant.
 *
 * ⚠ Отдаётся маршрутом из того же источника, что и страница (`shared/faq.ts`), а не файлом
 * в `public/`. Файл пришлось бы собирать отдельным шагом сборки, и у соседнего проекта именно этот
 * шаг однажды тихо выпал: юнит-тест собирателя оставался зелёным, а на сайте был 404, по которому
 * помощник клиента отвечал своими догадками. У маршрута такого шага нет — нечему выпадать.
 *
 * Ссылки в тексте — по публичному адресу приложения. Он не задан — ссылок нет вовсе: относительная
 * ссылка в документе, который читает чужой помощник, ведёт в никуда.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  return buildLlmsTxt(publicBaseUrl())
})
