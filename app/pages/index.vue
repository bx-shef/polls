<script setup lang="ts">
/**
 * The public landing page.
 *
 * ⚠ Единственная страница проекта, которой место в поисковой выдаче. Всё остальное —
 * `/app`, `/install`, вкладка сделки, публичная анкета — служебное и закрыто `noindex`.
 * Раньше в корне стояла заглушка каркаса с состоянием базы и Redis: она же была указана
 * в карточке Маркета как ссылка на приложение, то есть портал показывал бы сотруднику
 * отладочную панель, а поисковик индексировал бы её как главную страницу продукта.
 *
 * ⚠ Здесь НЕТ `b24ui` и нет ни одного знания о REST — ровно как на публичной странице
 * анкеты и по той же причине: это мир вне портала, со своей вёрсткой и своей политикой
 * безопасности (`frame-ancestors 'none'`).
 *
 * Тексты не выдуманы: взяты из `docs/market-graphics.md`, где они согласованы владельцем
 * как описание продукта для Маркета. Расходиться карточке Маркета и лендингу нельзя —
 * это одно обещание, данное в двух местах.
 */

const TITLE = 'Опросы клиентов'
const DESCRIPTION = 'Опрос уходит сам по стадии сделки, а ответы возвращаются в карточку клиента '
  + 'и превращаются в понятные цифры. Приложение для Битрикс24.'

useHead({
  title: `${TITLE} — приложение для Битрикс24`,
  meta: [
    { name: 'description', content: DESCRIPTION },
    { property: 'og:title', content: TITLE },
    { property: 'og:description', content: DESCRIPTION },
    { property: 'og:type', content: 'website' },
    { property: 'og:locale', content: 'ru_RU' },
  ],
  link: [{ rel: 'canonical', href: 'https://polls.bx-shef.by/' }],
  htmlAttrs: { lang: 'ru' },
})

/** Три шага пути — то же, что на изображении №3 карточки Маркета. */
const STEPS = [
  {
    title: 'Сделка доходит до стадии',
    text: 'Робот выпускает ссылку на опрос, портал отправляет её штатным письмом или сообщением. '
      + 'Свой SMTP и СМС-провайдер не нужны.',
  },
  {
    title: 'Клиент отвечает',
    text: 'Без регистрации, за пару минут, с телефона. Ссылка одноразовая и действует ограниченный срок.',
  },
  {
    title: 'Ответ возвращается в CRM',
    text: 'Балл и текст целиком попадают в историю сделки, прохождение сохраняется в смарт-процессе, '
      + 'итоговая оценка — в поле сделки.',
  },
]

/** Чем отличается от «просто формы» — три вещи, которых у формы нет. */
const DIFFERENCES = [
  {
    title: 'Ответ связан с контекстом CRM',
    text: 'Какая сделка, какая услуга, кто вёл. Поэтому цифра отвечает не только «сколько», но и «у кого».',
  },
  {
    title: 'Низкая оценка управляет процессом',
    text: 'Робот умеет дождаться ответа и повести сделку по другой ветке: поставить задачу, '
      + 'позвать руководителя, придержать закрытие.',
  },
  {
    title: 'Ответы остаются в вашем Битрикс24',
    text: 'Издатель их у себя не хранит — они пишутся в смарт-процесс на вашем портале. '
      + 'У нас только то, без чего доставка невозможна.',
  },
]
</script>

<template>
  <main class="page">
    <header class="hero">
      <p class="badge">
        Bitrix24 · Приложение
      </p>
      <h1>{{ TITLE }}</h1>
      <p class="lead">
        Опрос уходит сам по стадии сделки, а ответы возвращаются в карточку клиента
        и превращаются в понятные цифры.
      </p>
    </header>

    <section>
      <h2>Зачем</h2>
      <p>
        Компания узнаёт, что клиент недоволен, когда он уже решил не продлевать. Обратную связь
        собирают вручную: кто-то вспомнил спросить на созвоне, кто-то не вспомнил. Спрашивают
        чаще у довольных, чем у недовольных, — и картина по базе получается смещённой.
        А то, что всё-таки узнали, остаётся в голове аккаунт-менеджера и уходит вместе с ним.
      </p>
    </section>

    <section>
      <h2>Как это работает</h2>
      <ol class="steps">
        <li
          v-for="(step, index) in STEPS"
          :key="step.title"
        >
          <span class="num">{{ index + 1 }}</span>
          <div>
            <h3>{{ step.title }}</h3>
            <p>{{ step.text }}</p>
          </div>
        </li>
      </ol>
    </section>

    <section>
      <h2>Чем отличается от обычной формы</h2>
      <div class="cards">
        <article
          v-for="item in DIFFERENCES"
          :key="item.title"
        >
          <h3>{{ item.title }}</h3>
          <p>{{ item.text }}</p>
        </article>
      </div>
    </section>

    <section>
      <h2>Что видит руководитель</h2>
      <p>
        Не среднюю температуру, а доли по корзинам и выборку по порогу: кто поставил низкую
        оценку, с текстами и ответственными. Срез не показывается, пока в нём меньше пяти
        ответов, — по трём ответам «отчёт по менеджеру» деанонимизирует и клиента, и сотрудника.
      </p>
    </section>

    <footer class="foot">
      <p>
        Приложение устанавливается из Маркета Битрикс24 администратором портала.
        После установки вкладка «Опросы» появляется в карточке сделки.
      </p>
      <p class="muted">
        <a href="/eula">Лицензионное соглашение</a> ·
        <a href="/privacy-policy">Политика конфиденциальности</a>
      </p>
    </footer>
  </main>
</template>

<style scoped>
/*
 * Своя вёрстка без единой зависимости: страница живёт вне портала, `b24ui` сюда
 * не распространяется по правилу проекта. Обе темы обязательны — светлая и тёмная.
 */
.page {
  max-width: 44rem;
  margin: 0 auto;
  padding: 2.5rem 1rem 4rem;
  font: 1rem/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #1a1a1a;
}

.hero {
  margin-bottom: 3rem;
}

.badge {
  display: inline-block;
  margin: 0 0 1rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid #c8d3e0;
  border-radius: 999px;
  font-size: 0.8rem;
  color: #4a5b70;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 2.25rem;
  line-height: 1.15;
}

.lead {
  margin: 0;
  font-size: 1.15rem;
  color: #3d4b5c;
}

section {
  margin-bottom: 2.5rem;
}

h2 {
  margin: 0 0 0.75rem;
  font-size: 1.35rem;
}

h3 {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
}

p {
  margin: 0 0 0.75rem;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  gap: 0.9rem;
  margin-bottom: 1.25rem;
}

.num {
  flex: none;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 50%;
  background: #eef2f7;
  color: #2a3a4d;
  font-weight: 600;
  text-align: center;
  line-height: 1.9rem;
}

.cards {
  display: grid;
  gap: 1rem;
}

.cards article {
  padding: 1rem 1.1rem;
  border: 1px solid #e2e8f0;
  border-radius: 0.6rem;
}

.foot {
  padding-top: 1.5rem;
  border-top: 1px solid #e2e8f0;
}

.muted {
  color: #5c6b7a;
  font-size: 0.9rem;
}

a {
  color: #1f6feb;
}

@media (prefers-color-scheme: dark) {
  .page {
    color: #e6e6e6;
  }

  .lead {
    color: #b6c2cf;
  }

  .badge {
    border-color: #3a4756;
    color: #9fb0c3;
  }

  .num {
    background: #263040;
    color: #cfe0f3;
  }

  .cards article,
  .foot {
    border-color: #2c3543;
  }

  .muted {
    color: #9aa7b4;
  }

  a {
    color: #6cb0ff;
  }
}
</style>
