import type { SurveyBand, SurveyQuestion, SurveySection, SurveyTemplate } from './model'

/**
 * Checking a survey schema against the project's invariants, in plain words.
 *
 * ⚠ ОБЩИЙ, А НЕ КОНСТРУКТОРСКИЙ. Проверку покрытия шкалы диапазонами первым написал адаптер
 * импорта — там она и оплачена живыми данными: у анкеты `digital` диапазоны шли с четвёрки,
 * непокрытым оставался отрезок 0–4, и клиент с плохой оценкой не видел никакого текста.
 * Конструктору нужна ровно та же проверка. Написать её второй раз значило бы завести два
 * словаря на одну вещь, и разошлись бы они с первой правки — ровно то, от чего предостерегает
 * шапка `model.ts`.
 *
 * ⚠ Диапазоны проверяются ПО ТОЙ ЖЕ ЛОГИКЕ, по которой потом выбираются (`findBand`): границы
 * включительные с обеих сторон, соседние диапазоны смыкаются вплотную, на стыке побеждает
 * первый по порядку. Проверка, рассуждающая иначе, чем работает код, хуже её отсутствия:
 * она успокаивает.
 */

/** Насколько это плохо. Ошибка не даёт опубликовать, предупреждение только говорит. */
export type ProblemLevel = 'error' | 'warning'

/**
 * Одна претензия к схеме.
 *
 * ⚠ `where` — адрес ДЛЯ ЧЕЛОВЕКА («Раздел „Продукт“»), а не ключ. Конструктор читает
 * сотрудник клиента, и ключ `product` ему ни о чём не говорит: он видит заголовки.
 */
export interface TemplateProblem {
  level: ProblemLevel
  where: string
  message: string
}

/** Допустимый код анкеты: по нему живут ссылки, кэш версий и отчёты. */
const CODE_SHAPE = /^[a-z0-9][a-z0-9_-]{0,49}$/

/**
 * Границы возможного балла секции.
 *
 * Балл секции — средневзвешенное по отвеченным балльным вопросам, поэтому достижимый минимум
 * это наименьший минимум шкал, а максимум — наибольший максимум: ответив на один вопрос,
 * респондент получает ровно его значение.
 *
 * `null` — балльных вопросов нет вовсе, и говорить о покрытии шкалы нечего.
 */
export function sectionScale(questions: readonly SurveyQuestion[]): { min: number, max: number } | null {
  const scales = questions.map(q => q.scale).filter((s): s is { min: number, max: number } => s !== undefined)
  if (scales.length === 0) return null
  return {
    min: Math.min(...scales.map(s => s.min)),
    max: Math.max(...scales.map(s => s.max)),
  }
}

/**
 * Найти дыры в покрытии шкалы диапазонами. Пусто — дыр нет.
 *
 * Границы диапазонов смежные (…6–7.5, 7.5–8…), поэтому дырой считается только настоящий
 * разрыв: следующий начинается ВЫШЕ конца предыдущего.
 *
 * ⚠ Края шкалы проверяются отдельно, и это не педантизм. Сначала сравнивались только соседние
 * пары — и та единственная дыра, ради которой вся проверка писалась, не ловилась: у анкеты
 * `digital` диапазоны шли с 4 и между собой стыковались вплотную, а непокрытым оставался
 * отрезок 0–4. Клиент с плохой оценкой не видел никакого текста, а отчёт о переносе сказал бы
 * «дыр нет». Нашла панель ревью PR #14.
 *
 * ⚠ ПОКРЫТИЕ СЧИТАЕТСЯ ПО КОПИИ, ОТСОРТИРОВАННОЙ ПО НАЧАЛУ, и это исправление настоящего
 * дефекта, найденного при выносе проверки из адаптера импорта. Прежняя редакция шла по списку
 * как есть и сравнивала соседние пары, а конец шкалы проверяла по ПОСЛЕДНЕМУ элементу. В файле
 * снимка диапазоны всегда приходили по порядку, поэтому там это работало; в конструкторе автор
 * двигает их как хочет. На паре `0–10`, `3–5` прежняя проверка сообщала «шкала не покрыта
 * на отрезке 5–10» — то есть запрещала публиковать анкету, покрытую целиком.
 *
 * Дыра — свойство МНОЖЕСТВА диапазонов, а не их порядка: `findBand` перебирает весь список
 * и берёт первый подходящий, так что балл 8 найдёт диапазон `0–10`, где бы тот ни стоял.
 * Порядок несущий для другого — для того, КАКОЙ из подходящих победит; на это смотрит отдельная
 * проверка мёртвых диапазонов, и она как раз идёт по списку как есть.
 */
export function findScaleGaps(
  bands: readonly SurveyBand[],
  scale: { min: number, max: number } | null,
): string[] {
  if (bands.length === 0) return []

  // ⚠ Диапазон с нечисловой границей ОТБРАСЫВАЕТСЯ, а не участвует в подсчёте. `NaN`
  // в `reach` делает ложными все дальнейшие сравнения, и проверка, вместо того чтобы
  // ругаться, замолкает совсем: анкета с дырой публикуется как здоровая. Нашёл `/code-review`.
  // Сам испорченный диапазон при этом не теряется — про него ругается `validateTemplate`.
  const ordered = bands.filter(b => Number.isFinite(b.from) && Number.isFinite(b.to))
    .sort((a, b) => a.from - b.from)
  if (ordered.length === 0) return []
  const gaps: string[] = []

  if (scale !== null && ordered[0]!.from > scale.min) {
    gaps.push(`${scale.min}–${ordered[0]!.from}`)
  }

  // ⚠ `reach` — самый дальний УЖЕ покрытый балл, а не конец предыдущего диапазона. Вложенный
  // диапазон (`0–10`, затем `3–5`) иначе откатывал бы покрытие назад и порождал ложную дыру.
  let reach = ordered[0]!.to
  for (const band of ordered.slice(1)) {
    if (band.from > reach) gaps.push(`${reach}–${band.from}`)
    reach = Math.max(reach, band.to)
  }

  if (scale !== null && reach < scale.max) gaps.push(`${reach}–${scale.max}`)

  return gaps
}

/**
 * Проверить схему целиком — так, как её проверяет конструктор перед публикацией.
 *
 * Возвращает список претензий, пустой — анкету можно публиковать. Порядок: сначала общее
 * по анкете, потом по разделам сверху вниз, чтобы список читался как сама анкета.
 */
export function validateTemplate(schema: SurveyTemplate): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const anketa = 'Анкета'

  if (!CODE_SHAPE.test(schema.code)) {
    // Код — внешний ключ: по нему живут выпущенные ссылки, кэш версий и вся статистика.
    // Пробел или кириллица в нём ломают не показ, а сопоставление версий через полгода.
    problems.push({
      level: 'error',
      where: anketa,
      message: 'Код анкеты пуст или записан не латиницей. Разрешены строчные латинские буквы, цифры, дефис и подчёркивание — по коду живут выпущенные ссылки и вся накопленная статистика.',
    })
  }

  if (schema.title.trim() === '') {
    problems.push({
      level: 'error',
      where: anketa,
      message: 'У анкеты нет названия. Его видит человек, которому вы отправите ссылку.',
    })
  }

  if (schema.sections.length === 0) {
    problems.push({ level: 'error', where: anketa, message: 'В анкете нет ни одного раздела.' })
  }

  problems.push(...checkDuplicates(schema))

  for (const section of schema.sections) {
    problems.push(...checkSection(section))
  }

  return problems
}

/**
 * Повторы ключей — разделов и вопросов.
 *
 * ⚠ Ключ вопроса уникален В ПРЕДЕЛАХ ВЕРСИИ, а не раздела, и это инвариант проекта: по ключу
 * ответ находит свой вопрос при пересчёте. Два одинаковых ключа означают, что один ответ
 * повлияет на два балла — ровно то, что случилось в старом решении.
 */
function checkDuplicates(schema: SurveyTemplate): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const sectionKeys = new Set<string>()
  const questionKeys = new Map<string, string>()

  for (const section of schema.sections) {
    const where = sectionName(section)
    if (section.key.trim() === '') {
      problems.push({ level: 'error', where, message: 'У раздела пустой ключ.' })
    }
    else if (sectionKeys.has(section.key)) {
      problems.push({ level: 'error', where, message: `Ключ раздела «${section.key}» уже занят другим разделом.` })
    }
    sectionKeys.add(section.key)

    for (const question of section.questions) {
      const askedIn = questionKeys.get(question.key)
      if (question.key.trim() === '') {
        problems.push({ level: 'error', where: questionName(section, question), message: 'У вопроса пустой ключ.' })
        continue
      }
      if (askedIn !== undefined) {
        problems.push({
          level: 'error',
          where: questionName(section, question),
          message: `Ключ «${question.key}» уже занят вопросом в разделе «${askedIn}». Один ответ повлиял бы на два балла сразу.`,
        })
      }
      questionKeys.set(question.key, section.title || section.key)
    }
  }

  return problems
}

function checkSection(section: SurveySection): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const where = sectionName(section)

  if (section.title.trim() === '') {
    problems.push({ level: 'error', where, message: 'У раздела нет названия — его видит отвечающий.' })
  }

  if (section.questions.length === 0) {
    problems.push({ level: 'error', where, message: 'В разделе нет ни одного вопроса.' })
  }

  for (const question of section.questions) {
    problems.push(...checkQuestion(section, question))
  }

  problems.push(...checkBands(section))

  return problems
}

function checkQuestion(section: SurveySection, question: SurveyQuestion): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const where = questionName(section, question)

  if (question.title.trim() === '') {
    problems.push({ level: 'error', where, message: 'У вопроса нет формулировки — её видит отвечающий.' })
  }

  if (question.type === 'scale') {
    const scale = question.scale
    if (scale === undefined) {
      problems.push({ level: 'error', where, message: 'У балльного вопроса не задана шкала.' })
    }
    else if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.min >= scale.max) {
      problems.push({
        level: 'error',
        where,
        message: `Шкала ${scale.min}–${scale.max} не имеет смысла: начало должно быть меньше конца.`,
      })
    }
  }
  // ⚠ Тип и метрика — независимые оси (инвариант проекта), но балл считается ТОЛЬКО
  // по балльным вопросам: `scoreSection` отбирает `q.scored && q.type === 'scale'`.
  // Значит текстовый вопрос, помеченный идущим в оценку, — это не «другая метрика»,
  // а молчаливый ноль: автор думает, что вопрос считается, а он не считается.
  else if (question.scored) {
    problems.push({
      level: 'error',
      where,
      message: 'Вопрос помечен идущим в оценку, но балла не даёт: в оценку идут только балльные вопросы.',
    })
  }

  if (question.scored && question.type === 'scale' && !(question.weight > 0)) {
    problems.push({
      level: 'error',
      where,
      message: `Вес ${question.weight} у вопроса, идущего в оценку: с нулевым весом он не повлияет на балл вовсе.`,
    })
  }

  return problems
}

/**
 * Диапазоны интерпретации.
 *
 * ⚠ Инвариант проекта: они покрывают шкалу без дыр. Цена нарушения названа в нём же — клиент
 * с плохой оценкой не увидит ничего, и в старом решении это срабатывало в 100 % проверяемых
 * случаев.
 */
function checkBands(section: SurveySection): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const where = sectionName(section)
  const scoring = section.questions.filter(q => q.scored && q.type === 'scale')
  const scale = sectionScale(scoring)

  // ⚠ «Балльных вопросов нет» и «у них не задана шкала» — РАЗНЫЕ беды, и `sectionScale`
  // отвечает `null` на обе. Первая редакция различала их по этому `null` и на второй врала:
  // говорила «балльных вопросов в оценку нет» про раздел, где они есть, — и заодно молча
  // пропускала все остальные претензии к диапазонам. Нашёл `/code-review`.
  if (section.scored && scoring.length === 0) {
    problems.push({
      level: 'error',
      where,
      message: 'Раздел помечен балльным, но балльных вопросов в оценку в нём нет — балла у него не будет никогда.',
    })
    return problems
  }

  if (!section.scored) {
    if (section.bands.length > 0) {
      // Не ошибка: показывать нечего, потому что балла нет. Но автор явно рассчитывал
      // на обратное, и молчать об этом значит оставить его в заблуждении.
      problems.push({
        level: 'warning',
        where,
        message: 'У раздела без балла заданы диапазоны — их никто никогда не увидит.',
      })
    }
    return problems
  }

  if (section.bands.length === 0) {
    problems.push({
      level: 'error',
      where,
      message: 'У балльного раздела нет ни одного диапазона: отвечающий не увидит никакого текста по своей оценке.',
    })
    return problems
  }

  for (const band of section.bands) {
    if (!Number.isFinite(band.from) || !Number.isFinite(band.to)) {
      problems.push({ level: 'error', where, message: `Границы диапазона «${band.from}–${band.to}» не числа.` })
      continue
    }
    if (band.from > band.to) {
      problems.push({ level: 'error', where, message: `Диапазон ${band.from}–${band.to} перевёрнут.` })
    }
    if (band.text.trim() === '') {
      problems.push({ level: 'error', where, message: `У диапазона ${band.from}–${band.to} нет текста — его и видит отвечающий.` })
    }
  }

  for (const gap of findScaleGaps(section.bands, scale)) {
    problems.push({
      level: 'error',
      where,
      message: `Шкала не покрыта на отрезке ${gap}: отвечающий с такой оценкой не увидит никакого текста.`,
    })
  }

  // ⚠ Мёртвый диапазон: `findBand` берёт ПЕРВЫЙ подходящий, поэтому диапазон, целиком
  // накрытый более ранним, не сработает ни разу. Снаружи это выглядит как «текст почему-то
  // не тот», и искать причину будут в баллах.
  for (let i = 1; i < section.bands.length; i++) {
    const current = section.bands[i]!
    const covered = section.bands.slice(0, i).some(earlier => earlier.from <= current.from && earlier.to >= current.to)
    if (covered) {
      problems.push({
        level: 'warning',
        where,
        message: `Диапазон ${current.from}–${current.to} не сработает никогда: его целиком накрывает диапазон выше по списку.`,
      })
    }
  }

  return problems
}

function sectionName(section: SurveySection): string {
  return `Раздел «${section.title.trim() || section.key || 'без названия'}»`
}

function questionName(section: SurveySection, question: SurveyQuestion): string {
  return `${sectionName(section)}, вопрос «${question.title.trim() || question.key || 'без формулировки'}»`
}
