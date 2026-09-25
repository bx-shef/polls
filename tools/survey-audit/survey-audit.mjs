/**
 * Аудит качества анкетирования.
 *
 * Чистая функция: на вход — плоские записи ответов и приглашений,
 * на выходе — JSON с метриками, дефектами и вердиктами.
 * Хранилище значения не имеет: собери записи любым способом (SQL, REST, CSV)
 * и приведи к форматам ниже.
 *
 * @module survey-audit
 */

/**
 * @typedef {object} AnswerRecord Один ответ на один вопрос.
 * @property {string}  survey    Код опроса.
 * @property {string}  question  Ключ вопроса.
 * @property {'scale'|'text'} type Тип вопроса.
 * @property {number|string|null} value Значение: число для scale, строка для text.
 * @property {number} [scaleMin] Минимум шкалы (по умолчанию 0).
 * @property {number} [scaleMax] Максимум шкалы (по умолчанию 10).
 * @property {string} [responseId] Идентификатор прохождения — нужен для подсчёта сирот.
 */

/**
 * @typedef {object} InvitationRecord Одно приглашение.
 * @property {string}  survey     Код опроса.
 * @property {string}  period     Период группировки: '2025', '2025-Q1', '2025-08'.
 * @property {boolean} answered   Дошло ли до заполнения.
 * @property {string} [responseId] Ссылка на прохождение — нужна для подсчёта сирот.
 */

/** Пороги. Меняются под задачу, но по умолчанию выведены из разбора реальных данных. */
export const DEFAULT_THRESHOLDS = {
  /** Меньше этого числа ответов — статистику по вопросу не интерпретируем. */
  minN: 25,
  /** Доля верхней корзины, выше которой вопрос считается неразличающим. */
  ritualTopShare: 0.8,
  /** Доля пропусков/минимумов, выше которой вопрос считается непонятным респонденту. */
  unanswerableShare: 0.1,
  /** Доля двух верхних значений шкалы, выше которой среднее теряет смысл. */
  degenerateTopTwoShare: 0.6,
  /** Падение конверсии год к году в процентных пунктах, которое считаем деградацией. */
  funnelDecayPP: 10,
  /** Конверсия ниже этой — процесс не работает. */
  funnelFloor: 0.6,
  /** Доля осиротевших ответов, выше которой это системный дефект, а не случайность. */
  orphanShare: 0.05,
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const share = (n, total) => (total > 0 ? n / total : 0);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Границы корзин для шкалы. По умолчанию NPS-образные, пересчитываются под любую шкалу.
 *
 * ⚠ ТРИ КОРЗИНЫ ОБЯЗАНЫ БЫТЬ НЕПУСТЫМИ И НЕ ПЕРЕСЕКАТЬСЯ, и прежняя формула этого
 * не обеспечивала. На шкале 1–3 выходило `bottom = top = 2`: значение 2 попадало
 * и в верхнюю корзину, и в нижнюю, `inMid` уходил в минус, сумма долей превышала единицу,
 * а подпись средней корзины рендерилась как «3–1». На 1–5 средняя корзина оказывалась
 * пустой с подписью «4–3». Разбор старого решения держался на шкале 0–10, поэтому
 * на данных заказчика это не всплывало — всплыло бы на первом же опросе с короткой шкалой,
 * а «один из списка» с тремя вариантами обсуждается прямо сейчас. Нашёл `/code-review`
 * на панели PR #1, issue #3.
 *
 * Правило теперь такое:
 *
 * 1. Верх — «почти максимум»: десятая часть размаха сверху. На 0–10 это 9–10, как у NPS.
 * 2. Низ — шестьдесят процентов размаха снизу, как было.
 * 3. Низ ПРИЖИМАЕТСЯ так, чтобы между корзинами оставалось хотя бы одно значение.
 *    Это и есть то, чего не хватало: на коротких шкалах шестьдесят процентов съедают
 *    середину целиком.
 *
 * @param {number} min
 * @param {number} max
 * @returns {{bottom: number, top: number} | null} `null` — шкала короче трёх делений,
 *   корзин на ней не бывает: между «низом» и «верхом» нечему лежать. Вызывающий обязан
 *   это проверить и не считать долей, а не подставлять своё.
 */
export function bucketBounds(min, max) {
  const span = max - min;
  // Меньше трёх делений — делить не на что. Честный отказ лучше трёх корзин,
  // две из которых совпадают.
  if (!Number.isFinite(span) || span < 2) return null;

  const top = max - Math.round(span * 0.1);
  const raw = min + Math.round(span * 0.6);
  // Между корзинами обязано остаться хотя бы одно значение — иначе середина пуста,
  // а её подпись читается задом наперёд.
  const bottom = Math.min(raw, top - 2);

  return { bottom, top };
}

/**
 * Гистограмма и форма распределения по всем балльным ответам.
 * @param {AnswerRecord[]} scaleAnswers
 * @param {typeof DEFAULT_THRESHOLDS} t
 */
function analyseDistribution(scaleAnswers, t) {
  const values = scaleAnswers.map((a) => Number(a.value)).filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;

  const min = Math.min(...scaleAnswers.map((a) => a.scaleMin ?? 0));
  const max = Math.max(...scaleAnswers.map((a) => a.scaleMax ?? 10));
  const bounds = bucketBounds(min, max);

  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const byValue = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, n]) => ({ value: v, n, share: round(share(n, values.length), 4) }));

  const topTwo = sum(byValue.filter((b) => b.value >= max - 1).map((b) => b.n));

  const common = {
    n: values.length,
    scale: { min, max },
    byValue,
    avg: round(sum(values) / values.length),
    mode: byValue.slice().sort((a, b) => b.n - a.n)[0].value,
    topTwoShare: round(share(topTwo, values.length), 4),
    /** Среднее осмысленно только на невырожденном распределении. */
    averageIsMeaningful: share(topTwo, values.length) < t.degenerateTopTwoShare,
  };

  // ⚠ На шкале короче трёх делений корзин НЕ БЫВАЕТ, и отчёт говорит об этом прямо,
  // а не показывает доли, которые не сходятся в единицу. Гистограмма и среднее при этом
  // остаются: они осмысленны на любой шкале.
  if (bounds === null) {
    return { ...common, buckets: null, shares: null, index: null,
      bucketsSkipped: 'шкала короче трёх делений — корзины на ней не считаются' };
  }

  const { bottom, top } = bounds;
  const inTop = values.filter((v) => v >= top).length;
  const inBottom = values.filter((v) => v <= bottom).length;
  const inMid = values.length - inTop - inBottom;

  return {
    ...common,
    buckets: { top: `${top}–${max}`, mid: `${bottom + 1}–${top - 1}`, bottom: `${min}–${bottom}` },
    shares: {
      top: round(share(inTop, values.length), 4),
      mid: round(share(inMid, values.length), 4),
      bottom: round(share(inBottom, values.length), 4),
    },
    /** Индекс «доля верхней корзины минус доля нижней», в пунктах. NPS-подобный, но не NPS. */
    index: Math.round((share(inTop, values.length) - share(inBottom, values.length)) * 100),
    bucketsSkipped: null,
  };
}

/**
 * Ищет аномальный пик на минимуме шкалы — признак того, что виджет
 * отправляет нетронутое поле как крайнее значение.
 * @param {ReturnType<typeof analyseDistribution>} dist
 */
function detectDefaultValueSpike(dist) {
  if (!dist) return null;
  const at = (v) => dist.byValue.find((b) => b.value === v)?.n ?? 0;
  const { min } = dist.scale;
  const nMin = at(min);
  const neighbours = [at(min + 1), at(min + 2), at(min + 3)].filter((n) => n > 0);
  if (nMin === 0 || neighbours.length === 0) return null;
  const expected = Math.max(...neighbours);
  if (nMin <= expected) return null;
  return {
    code: 'SCALE_DEFAULT_SPIKE',
    severity: 'high',
    message:
      `На минимуме шкалы (${min}) ${nMin} ответов — больше, чем на соседних значениях (${neighbours.join(', ')}). ` +
      'Для убывающего к низу распределения это аномалия: похоже, нетронутое поле уходит как крайнее значение. ' +
      'Отличить «поставил минимум» от «пропустил вопрос» в этих данных нельзя.',
    evidence: { valueAtMin: nMin, neighbours, excess: nMin - expected },
  };
}

/**
 * Шкала группы — согласованная по ВСЕМ её строкам, а не взятая из первой.
 *
 * ⚠ Прежняя редакция читала `rows[0].scaleMin ?? 0` и распространяла это на всю группу.
 * Две беды сразу. Если у первой строки границ не было, молча подставлялось 0–10 — и вопрос
 * уже никогда не получал вердикт `ritual` или `unanswerable`, потому что считался по чужой
 * шкале. Если строки расходились между собой, побеждала случайная. Молчаливость здесь
 * и есть проблема: инструмент выдаёт правдоподобный отчёт, в котором часть вопросов
 * оценена не по своей шкале. Нашёл `/code-review` на панели PR #1, issue #3.
 *
 * Берём самую широкую из объявленных и ГОВОРИМ ВСЛУХ, если пришлось догадываться
 * или если строки разошлись.
 *
 * @param {AnswerRecord[]} rows
 * @returns {{min: number, max: number, assumed: boolean, mixed: boolean}}
 */
function resolveGroupScale(rows) {
  const mins = [...new Set(rows.map((r) => r.scaleMin).filter((v) => Number.isFinite(v)))];
  const maxs = [...new Set(rows.map((r) => r.scaleMax).filter((v) => Number.isFinite(v)))];

  return {
    min: mins.length > 0 ? Math.min(...mins) : 0,
    max: maxs.length > 0 ? Math.max(...maxs) : 10,
    /** Границ не объявила ни одна строка — 0–10 это наша догадка, а не данные. */
    assumed: mins.length === 0 && maxs.length === 0,
    /** Строки группы объявили разные границы — взята самая широкая. */
    mixed: mins.length > 1 || maxs.length > 1,
  };
}

/** Оговорки к шкале словами — их читает человек в отчёте. */
function scaleNotes(scale) {
  const notes = [];
  if (scale.assumed) notes.push(`Границы шкалы не заданы ни одной строкой — считали по ${scale.min}–${scale.max}.`);
  if (scale.mixed) notes.push(`Строки объявили РАЗНЫЕ границы шкалы — взята самая широкая, ${scale.min}–${scale.max}.`);
  return notes;
}

/**
 * Метрики и вердикт по каждому балльному вопросу.
 * @param {AnswerRecord[]} scaleAnswers
 * @param {typeof DEFAULT_THRESHOLDS} t
 */
function analyseQuestions(scaleAnswers, t) {
  const groups = new Map();
  for (const a of scaleAnswers) {
    const key = `${a.survey}\u0000${a.question}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const out = [];
  for (const [key, rows] of groups) {
    const [survey, question] = key.split('\u0000');
    const scale = resolveGroupScale(rows);
    const bounds = bucketBounds(scale.min, scale.max);
    const values = rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
    if (values.length === 0) continue;

    // ⚠ Доля на минимуме считается ВСЕГДА: границ корзин она не требует, а вердикт
    // «неприменимый вопрос» держится именно на ней.
    const minShare = share(values.filter((v) => v === scale.min).length, values.length);
    const topShare = bounds === null ? null : share(values.filter((v) => v >= bounds.top).length, values.length);
    const lowShare = bounds === null ? null : share(values.filter((v) => v <= bounds.bottom).length, values.length);

    let verdict = 'working';
    let why = 'Вопрос различает респондентов.';
    if (values.length < t.minN) {
      verdict = 'insufficient-data';
      why = `Ответов ${values.length} при пороге ${t.minN} — выводы не делаем.`;
    } else if (topShare !== null && topShare > t.ritualTopShare) {
      verdict = 'ritual';
      why = `${Math.round(topShare * 100)} % ответов в верхней корзине — вопрос почти не различает клиентов.`;
    } else if (minShare > t.unanswerableShare) {
      verdict = 'unanswerable';
      why = `${Math.round(minShare * 100)} % ответов на минимуме шкалы — вопрос, вероятно, неприменим или непонятен.`;
    }

    out.push({
      survey,
      question,
      n: values.length,
      scale,
      avg: round(sum(values) / values.length),
      topShare: topShare === null ? null : round(topShare, 4),
      lowShare: lowShare === null ? null : round(lowShare, 4),
      minShare: round(minShare, 4),
      verdict,
      // ⚠ Оговорки приписываются к объяснению, а не прячутся в соседнее поле: отчёт читают
      // глазами, и «вердикт посчитан по шкале, о которой мы догадались» обязано стоять рядом
      // с самим вердиктом.
      why: [why, ...scaleNotes(scale), ...(bounds === null ? ['Шкала короче трёх делений — корзины не считались.'] : [])].join(' '),
    });
  }
  // ⚠ Сортировка терпит `null`: у вопроса на короткой шкале верхней корзины нет вовсе,
  // и такие уходят в конец, а не превращают порядок в кашу.
  return out.sort((a, b) => (a.topShare ?? 2) - (b.topShare ?? 2));
}

/**
 * Заполняемость и содержательность открытых вопросов.
 * @param {AnswerRecord[]} textAnswers
 */
function analyseOpenQuestions(textAnswers) {
  const groups = new Map();
  for (const a of textAnswers) {
    const key = `${a.survey}\u0000${a.question}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(typeof a.value === 'string' ? a.value : '');
  }
  return [...groups.entries()]
    .map(([key, vals]) => {
      const [survey, question] = key.split('\u0000');
      const filled = vals.filter((v) => v.trim().length > 0);
      const lens = filled.map((v) => v.trim().length);
      return {
        survey,
        question,
        total: vals.length,
        filled: filled.length,
        fillRate: round(share(filled.length, vals.length), 4),
        avgLength: lens.length ? Math.round(sum(lens) / lens.length) : 0,
        maxLength: lens.length ? Math.max(...lens) : 0,
      };
    })
    .sort((a, b) => a.fillRate - b.fillRate);
}

/**
 * Воронка приглашение → ответ по периодам.
 * @param {InvitationRecord[]} invitations
 * @param {typeof DEFAULT_THRESHOLDS} t
 */
function analyseFunnel(invitations, t) {
  const byPeriod = new Map();
  for (const i of invitations) {
    if (!byPeriod.has(i.period)) byPeriod.set(i.period, { sent: 0, answered: 0 });
    const p = byPeriod.get(i.period);
    p.sent += 1;
    if (i.answered) p.answered += 1;
  }
  const rows = [...byPeriod.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([period, v]) => ({ period, ...v, rate: round(share(v.answered, v.sent), 4) }));

  const defects = [];
  for (let i = 1; i < rows.length; i += 1) {
    const dropPP = (rows[i - 1].rate - rows[i].rate) * 100;
    if (dropPP >= t.funnelDecayPP) {
      defects.push({
        code: 'FUNNEL_DECAY',
        severity: 'medium',
        message:
          `Конверсия упала с ${Math.round(rows[i - 1].rate * 100)} % (${rows[i - 1].period}) ` +
          `до ${Math.round(rows[i].rate * 100)} % (${rows[i].period}). ` +
          'Обычно это значит, что ручное «дожимание» перестало справляться с объёмом — нужны автонапоминания.',
        evidence: { from: rows[i - 1], to: rows[i], dropPP: round(dropPP, 1) },
      });
    }
  }
  const last = rows[rows.length - 1];
  if (last && last.rate < t.funnelFloor) {
    defects.push({
      code: 'FUNNEL_LOW',
      severity: 'high',
      message: `Конверсия последнего периода ${Math.round(last.rate * 100)} % — ниже порога ${Math.round(
        t.funnelFloor * 100,
      )} %. Большая часть приглашений не доходит до ответа.`,
      evidence: last,
    });
  }
  return { rows, defects };
}

/**
 * Целостность: ответы, потерявшие приглашение.
 * @param {AnswerRecord[]} answers
 * @param {InvitationRecord[]} invitations
 * @param {typeof DEFAULT_THRESHOLDS} t
 */
function analyseIntegrity(answers, invitations, t) {
  const known = new Set(invitations.map((i) => i.responseId).filter(Boolean));
  const seen = new Set(answers.map((a) => a.responseId).filter(Boolean));
  if (known.size === 0 || seen.size === 0) return { checked: false, defects: [] };

  const orphans = [...seen].filter((id) => !known.has(id));
  const orphanShare = share(orphans.length, seen.size);
  const defects = [];
  if (orphans.length > 0) {
    defects.push({
      code: 'ORPHANED_RESPONSES',
      severity: orphanShare > t.orphanShare ? 'high' : 'medium',
      message:
        `${orphans.length} прохождений из ${seen.size} (${Math.round(orphanShare * 100)} %) не имеют приглашения. ` +
        'Ответы есть, а привязка к клиенту, сделке и дате потеряна. ' +
        'Любая статистика по «живым» карточкам будет занижена, а история — неполной.',
      evidence: { orphans: orphans.length, total: seen.size, share: round(orphanShare, 4) },
    });
  }
  return { checked: true, responses: seen.size, linked: seen.size - orphans.length, orphans: orphans.length, orphanShare: round(orphanShare, 4), defects };
}

/**
 * Полный аудит.
 * @param {{answers: AnswerRecord[], invitations?: InvitationRecord[]}} input
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [overrides]
 * @returns {object} Метрики, дефекты и вердикты — готовы к передаче в LLM или в отчёт.
 */
export function audit({ answers, invitations = [] }, overrides = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const scaleAnswers = answers.filter((a) => a.type === 'scale' && a.value !== null && a.value !== '');
  const textAnswers = answers.filter((a) => a.type === 'text');

  const distribution = analyseDistribution(scaleAnswers, t);
  const questions = analyseQuestions(scaleAnswers, t);
  const open = analyseOpenQuestions(textAnswers);
  const funnel = analyseFunnel(invitations, t);
  const integrity = analyseIntegrity(answers, invitations, t);

  const defects = [
    ...integrity.defects,
    ...funnel.defects,
    detectDefaultValueSpike(distribution),
  ].filter(Boolean);

  if (distribution && !distribution.averageIsMeaningful) {
    defects.push({
      code: 'DEGENERATE_SCALE',
      severity: 'medium',
      message:
        `${Math.round(distribution.topTwoShare * 100)} % ответов приходится на два верхних значения шкалы. ` +
        'Как непрерывная метрика шкала не работает: среднее не отличает «хорошо» от «отлично». ' +
        'Считай доли по корзинам и следи за индексом, а не за средним баллом.',
      evidence: { topTwoShare: distribution.topTwoShare, avg: distribution.avg, index: distribution.index },
    });
  }

  const ritual = questions.filter((q) => q.verdict === 'ritual');
  if (ritual.length > 0) {
    defects.push({
      code: 'RITUAL_QUESTIONS',
      severity: 'low',
      message:
        `${ritual.length} вопрос(ов) почти всегда получают верхние оценки и не различают клиентов. ` +
        'Они тратят время респондента и разбавляют анкету — кандидаты на удаление.',
      evidence: ritual.map((q) => ({ survey: q.survey, question: q.question, topShare: q.topShare })),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    thresholds: t,
    totals: {
      answers: answers.length,
      scaleAnswers: scaleAnswers.length,
      textAnswers: textAnswers.length,
      invitations: invitations.length,
      surveys: new Set(answers.map((a) => a.survey)).size,
      questions: questions.length,
    },
    funnel: funnel.rows,
    integrity,
    distribution,
    questions,
    openQuestions: open,
    defects: defects.sort(
      (a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity],
    ),
  };
}

/* CLI: node survey-audit.mjs data.json > report.json
   Файл должен содержать { "answers": [...], "invitations": [...] }. */
if (process.argv[1] && process.argv[1].endsWith('survey-audit.mjs') && process.argv[2]) {
  const { readFileSync } = await import('node:fs');
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(`${JSON.stringify(audit(input), null, 2)}\n`);
}
