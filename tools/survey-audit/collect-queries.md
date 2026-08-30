# Сбор данных для аудита

Скрипту всё равно, откуда пришли записи. Ниже — рецепты для двух типовых источников. Задача каждого
запроса: получить плоские строки, которые лягут в `answers` и `invitations`.

Общее правило: **сначала запросы с маленьким результатом, потом с большим.** Инвентаризация и
гистограмма дают большую часть выводов и занимают десяток строк; разрез по вопросам — сотни строк,
и делать его до того, как проверена целостность, бессмысленно.

---

## Источник A: приложение с нормальной реляционной моделью

Если опросы уже живут в своей схеме (`surveys`, `survey_versions`, `invitations`, `responses`,
`answers`), всё сводится к четырём запросам.

**A1. Инвентаризация.**

```sql
SELECT s.code AS survey,
       COUNT(DISTINCT v.id)  AS versions,
       COUNT(DISTINCT i.id)  AS invitations,
       COUNT(DISTINCT r.id)  AS responses,
       MIN(r.finished_at)    AS first_response,
       MAX(r.finished_at)    AS last_response
FROM surveys s
LEFT JOIN survey_versions v ON v.survey_id = s.id
LEFT JOIN invitations i     ON i.survey_version_id = v.id
LEFT JOIN responses r       ON r.invitation_id = i.id
GROUP BY s.code
ORDER BY responses DESC NULLS LAST;
```

**A2. Целостность — прохождения без приглашения.**

```sql
SELECT COUNT(*) AS orphans
FROM responses r
LEFT JOIN invitations i ON i.id = r.invitation_id
WHERE i.id IS NULL;
```

**A3. Воронка.**

```sql
SELECT to_char(i.created_at, 'YYYY') AS period,
       s.code                        AS survey,
       COUNT(*)                                        AS sent,
       COUNT(*) FILTER (WHERE i.completed_at IS NOT NULL) AS answered
FROM invitations i
JOIN survey_versions v ON v.id = i.survey_version_id
JOIN surveys s         ON s.id = v.survey_id
GROUP BY period, survey
ORDER BY period, survey;
```

**A4. Ответы для скрипта.** Одна строка на ответ; тип и границы шкалы берём из схемы версии.

```sql
SELECT s.code                                   AS survey,
       a.question_key                           AS question,
       (a.value ? 'scale')::bool                AS is_scale,
       a.value                                  AS value,
       r.id::text                               AS "responseId"
FROM answers a
JOIN responses r       ON r.id = a.response_id
JOIN invitations i     ON i.id = r.invitation_id
JOIN survey_versions v ON v.id = i.survey_version_id
JOIN surveys s         ON s.id = v.survey_id;
```

Конкретный разбор `value` зависит от того, как хранится ответ; задача — на выходе получить
`type: 'scale' | 'text'` и число либо строку.

---

## Источник B: самописное решение на Битриксе

Здесь данные почти наверняка размазаны по трём хранилищам, и ORM не спасает: карточка анкеты в
инфоблоке, ответы в highload-блоках, структура — в опциях модуля. Порядок такой.

**B1. Что вообще есть.** Одним запросом: инфоблок, HL-таблицы, ключи настроек.

```sql
SELECT 'iblock' AS src, CAST(ID AS CHAR) AS a, CODE AS b, NAME AS c, CAST(VERSION AS CHAR) AS d
FROM b_iblock WHERE ID = :IBLOCK_ID
UNION ALL
SELECT 'hlblock', CAST(ID AS CHAR), TABLE_NAME, NAME, ''
FROM b_hlblock_entity WHERE TABLE_NAME LIKE :TABLE_PREFIX
UNION ALL
SELECT 'option', '', NAME, LEFT(VALUE, 120), CAST(CHAR_LENGTH(VALUE) AS CHAR)
FROM b_option WHERE MODULE_ID = :MODULE_ID;
```

Колонка `d` у строки `iblock` — это `VERSION`, и от неё зависит всё дальнейшее:

- `VERSION = 1` — значения свойств в общей `b_iblock_element_property`;
- `VERSION = 2` — в отдельной `b_iblock_element_prop_s<IBLOCK_ID>`, колонками `PROPERTY_<ID>`.

**B2. Конфигурация опросов.** Обычно лежит JSON-ом в опциях модуля — это самая ценная выборка,
из неё видно структуру, веса и пороги интерпретации. Забирать текстом, а не скриншотом.

```sql
SELECT NAME, VALUE FROM b_option WHERE MODULE_ID = :MODULE_ID ORDER BY NAME;
```

**B3. Идентификаторы свойств** — нужны, чтобы собрать запрос под `VERSION = 2`.

```sql
SELECT 'prop' AS kind, p.ID AS id, p.CODE AS code, p.NAME AS name, p.PROPERTY_TYPE AS ptype, p.SORT AS srt, '' AS xml_id
FROM b_iblock_property p WHERE p.IBLOCK_ID = :IBLOCK_ID
UNION ALL
SELECT 'enum', e.ID, p.CODE, e.VALUE, 'L', e.SORT, e.XML_ID
FROM b_iblock_property_enum e
JOIN b_iblock_property p ON p.ID = e.PROPERTY_ID
WHERE p.IBLOCK_ID = :IBLOCK_ID
ORDER BY kind, srt;
```

**B4. Состав вопросов.** В такой архитектуре вопрос — это пользовательское поле highload-блока, а
формулировка живёт в его подписи и больше нигде.

```sql
SELECT h.TABLE_NAME AS tbl, f.FIELD_NAME AS fld, f.USER_TYPE_ID AS utype, f.SORT AS srt,
       l.EDIT_FORM_LABEL AS title
FROM b_user_field f
JOIN b_hlblock_entity h ON f.ENTITY_ID = CONCAT('HLBLOCK_', h.ID)
LEFT JOIN b_user_field_lang l ON l.USER_FIELD_ID = f.ID AND l.LANGUAGE_ID = 'ru'
WHERE h.TABLE_NAME LIKE :TABLE_PREFIX
ORDER BY h.TABLE_NAME, f.SORT;
```

Сверь количество полей с тем, что объявлено в конфигурации из B2. Расхождение — это либо поле,
объявленное и не созданное, либо созданное и забытое; и то и другое стоит знать заранее, иначе
следующий запрос упадёт на несуществующей колонке.

**B5. Воронка** (вариант для `VERSION = 2`; подставь свои идентификаторы свойств из B3).

```sql
SELECT YEAR(el.DATE_CREATE) AS period,
       COALESCE(tp.XML_ID, '(нет)') AS survey,
       COUNT(*) AS sent,
       SUM(CASE WHEN ps.PROPERTY_<DATA_ID> IS NOT NULL AND ps.PROPERTY_<DATA_ID> <> '' THEN 1 ELSE 0 END) AS answered
FROM b_iblock_element el
JOIN b_iblock_element_prop_s<IBLOCK_ID> ps ON ps.IBLOCK_ELEMENT_ID = el.ID
LEFT JOIN b_iblock_property_enum tp ON tp.ID = ps.PROPERTY_<TYPE>
WHERE el.IBLOCK_ID = :IBLOCK_ID
GROUP BY period, survey
ORDER BY period, survey;
```

**B6. Ответы.** Highload-блок хранит вопрос в колонке, поэтому нужен `UNION ALL` по колонкам —
по одной строке на вопрос. Собирается генератором из результата B4:

```sql
SELECT CONCAT(
  'SELECT ''', h.TABLE_NAME, ''' AS survey, ''', f.FIELD_NAME, ''' AS question, ',
  f.FIELD_NAME, ' AS value, ID AS "responseId" FROM ', h.TABLE_NAME, ' UNION ALL'
) AS sql_text
FROM b_user_field f
JOIN b_hlblock_entity h ON f.ENTITY_ID = CONCAT('HLBLOCK_', h.ID)
WHERE h.TABLE_NAME LIKE :TABLE_PREFIX AND f.USER_TYPE_ID IN ('double', 'string')
ORDER BY h.TABLE_NAME, f.SORT;
```

Генератор возвращает готовые строки: склей их в один запрос, у последней убери хвостовой
`UNION ALL`. Так запрос строится по фактически существующим колонкам и не падает на расхождении
между конфигурацией и хранилищем.

Гистограмму по всем баллам можно получить, не выгружая ответы построчно, — обернув тот же
`UNION ALL`:

```sql
SELECT value AS ocenka, COUNT(*) AS otvetov
FROM ( /* склеенный UNION ALL по числовым колонкам */ ) x
WHERE value IS NOT NULL
GROUP BY value ORDER BY value;
```

Одиннадцать строк на выходе — и главный вопрос о шкале закрыт.

**B7. Целостность.** Сравни количество строк в highload-блоках с количеством карточек, у которых
заполнена ссылка на данные. Разница — осиротевшие ответы: карточку удалили, ответ остался. На
боевом наборе это оказалась треть всех прохождений, и без этой проверки конверсия по нескольким
направлениям выглядела втрое хуже реальной.

---

## Приведение к формату скрипта

```js
const answers = rows.map((r) => ({
  survey: r.survey,
  question: r.question,
  type: r.utype === 'double' ? 'scale' : 'text',
  value: r.utype === 'double' ? Number(r.value) : String(r.value ?? ''),
  scaleMin: 0,
  scaleMax: 10,
  responseId: String(r.responseId),
}));
```

Границы шкалы бери из конфигурации опроса, а не из данных: если по вопросу никто не ставил
максимум, вычисленный из данных `scaleMax` окажется занижен и все доли поедут.
