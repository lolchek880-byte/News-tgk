const express = require("express");
const fetch = require("node-fetch");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

const app = express();

/* =========================================================
   AI NEWS BOT v0.5.1
========================================================= */

const VERSION = "0.5.3";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

const CHECK_INTERVAL_MIN = parseInt(
  process.env.CHECK_INTERVAL_MIN || "5",
  10
);

const RUN_SECRET = process.env.RUN_SECRET || null;

const TIMEZONE = "Europe/Moscow";

/* Максимум 1 пост в минуту */
const POST_INTERVAL_MS = 60 * 1000;

/* Сколько последних новостей на источник храним для защиты от повторов.
   Раньше было 2 — этого не хватало: как только по источнику выходило
   больше 2 новых новостей между проверками, старые ссылки "забывались"
   и бот публиковал их заново. Теперь храним намного больше и вдобавок
   чистим по времени (см. POSTED_MAX_AGE_MS), а не только по количеству. */
const REMEMBER_PER_SOURCE = 500;

/* Сколько последних записей на источник используем для проверки похожести
   заголовков (не всю историю — иначе будут случайные ложные совпадения) */
const SIMILARITY_CHECK_WINDOW = 15;

/* Как долго хранить историю опубликованного/пропущенного, чтобы файл
   не рос бесконечно, но при этом реально защищал от повторов */
const POSTED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней

/* Не публиковать новости старше этого возраста (по дате из RSS) */
const MAX_NEWS_AGE_MS = 60 * 60 * 1000; // 1 час

/* Похожесть */
const SIMILARITY_THRESHOLD = parseFloat(
  process.env.SIMILARITY_THRESHOLD || "0.55"
);

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* =========================================================
   RSS SOURCES
========================================================= */

const FEEDS = [
  {
    id: "mk",
    name: "МК",
    color: "🔴",
    url: "https://www.mk.ru/rss/news/index.xml",
  },

  {
    id: "rbc",
    name: "РБК",
    color: "🔵",
    url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
  },

  {
    id: "gazeta",
    name: "Газета.Ru",
    color: "🟡",
    url: "https://www.gazeta.ru/export/rss/first.xml",
  },

  {
    id: "tass",
    name: "ТАСС",
    color: "⚪️",
    url: "https://tass.ru/rss/v2.xml?section=politics",
  },

  {
    id: "rambler",
    name: "Рамблер",
    color: "🟠",
    url: "https://news.rambler.ru/rss/politics/",
  },

  {
    id: "dw",
    name: "DW",
    color: "🟢",
    url: "https://rss.dw.com/rdf/rss-ru-all",
  },
];

/* =========================================================
   CATEGORIES
========================================================= */

const CATEGORIES = [
  {
    id: "politics",
    name: "Политика",
    emoji: "🏛",
  },
  {
    id: "economy",
    name: "Экономика",
    emoji: "💰",
  },
  {
    id: "world",
    name: "Мир",
    emoji: "🌍",
  },
  {
    id: "conflicts",
    name: "Конфликты",
    emoji: "⚔️",
  },
  {
    id: "technology",
    name: "Технологии",
    emoji: "💻",
  },
  {
    id: "science",
    name: "Наука",
    emoji: "🔬",
  },
  {
    id: "space",
    name: "Космос",
    emoji: "🚀",
  },
  {
    id: "sport",
    name: "Спорт",
    emoji: "🏎",
  },
  {
    id: "culture",
    name: "Культура",
    emoji: "🎬",
  },
  {
    id: "society",
    name: "Общество",
    emoji: "🌐",
  },
  {
    id: "incidents",
    name: "Происшествия",
    emoji: "🚨",
  },
];

/* =========================================================
   FILE STORAGE
========================================================= */

const DATA_DIR = path.join(__dirname, "data");

const POSTED_FILE = path.join(
  DATA_DIR,
  "posted.json"
);

const STATE_FILE = path.join(
  DATA_DIR,
  "state.json"
);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

function writeIfMissing(file, value) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(value, null, 2),
      "utf8"
    );
  }
}

writeIfMissing(
  POSTED_FILE,
  {
    sources: {},
  }
);

writeIfMissing(
  STATE_FILE,
  {
    version: VERSION,
    initialized: false,
    postingEnabled: true,

    startedAt: null,
    lastCheck: null,
    lastPost: null,

    currentStage: "Запуск",
    currentDetails: "",

    totalFound: 0,
    totalPosted: 0,
    totalSkipped: 0,
    totalErrors: 0,

    sourceStats: {},

    posts24h: {},
  }
);

function readJSON(file, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

function saveJSON(file, value) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(value, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Ошибка сохранения:",
      error.message
    );
  }
}

let postedData = readJSON(
  POSTED_FILE,
  {
    sources: {},
  }
);

let state = readJSON(
  STATE_FILE,
  {}
);

state.version = VERSION;
state.startedAt =
  new Date().toISOString();

state.sourceStats =
  state.sourceStats || {};

state.posts24h =
  state.posts24h || {};

for (const source of FEEDS) {
  if (!Array.isArray(postedData.sources[source.id])) {
    postedData.sources[source.id] = [];
  }

  if (!state.sourceStats[source.id]) {
    state.sourceStats[source.id] = {
      found: 0,
      posted: 0,
      skipped: 0,
      errors: 0,
      status: "⚪ Не проверялся",
      lastCheck: null,
      lastError: null,
    };
  }
}

saveJSON(
  POSTED_FILE,
  postedData
);

saveJSON(
  STATE_FILE,
  state
);

/* =========================================================
   RUNTIME
========================================================= */

let isChecking = false;
let publisherRunning = false;
let adminPollingRunning = false;

let publicationQueue = [];

let lastPublicationTime = state.lastPost
  ? new Date(state.lastPost).getTime()
  : 0;

let telegramUpdateOffset = 0;

let adminStatusMessageId = null;

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value, max) {
  const text = String(value || "")
    .trim();

  if (text.length <= max) {
    return text;
  }

  return (
    text
      .slice(0, max - 1)
      .trimEnd() + "…"
  );
}

function moscowDate(date = new Date()) {
  /* Раньше сюда часто передавали ISO-строку (state.lastCheck и т.п.)
     вместо объекта Date. Intl.DateTimeFormat.format() не умеет сам
     превращать строку в дату и падает с "Invalid time value".
     Это и было настоящей причиной падения кнопок "Статус"/"Источники". */
  const safeDate =
    date instanceof Date
      ? date
      : new Date(date);

  if (isNaN(safeDate.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }
  ).format(safeDate);
}

function moscowTime(date = new Date()) {
  const safeDate =
    date instanceof Date
      ? date
      : new Date(date);

  if (isNaN(safeDate.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  ).format(safeDate);
}

function sourceById(id) {
  return FEEDS.find(
    (source) => source.id === id
  );
}

function categoryById(id) {
  return CATEGORIES.find(
    (category) => category.id === id
  );
}

/* =========================================================
   TELEGRAM API
========================================================= */

async function telegram(
  method,
  body = {}
) {
  const response = await fetch(
    `${API_URL}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
        `Telegram ${method} error`
    );
  }

  return data.result;
}

/* =========================================================
   STAGE
========================================================= */

function setStage(
  stage,
  details = ""
) {
  state.currentStage = stage;
  state.currentDetails =
    details;

  saveJSON(
    STATE_FILE,
    state
  );

  console.log(
    `[${moscowTime()} МСК] ${stage}` +
      (details
        ? ` — ${details}`
        : "")
  );

  updateAdminStatus().catch(
    () => {}
  );
}

/* =========================================================
   ADMIN KEYBOARD
========================================================= */

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "📊 Статус",
          callback_data:
            "status",
        },
        {
          text: "📡 Источники",
          callback_data:
            "sources",
        },
      ],

      [
        {
          text: "📂 Разделы",
          callback_data:
            "categories",
        },
        {
          text: "🏆 Топ 24ч",
          callback_data:
            "top24",
        },
      ],

      [
        {
          text: "📈 Статистика",
          callback_data:
            "statistics",
        },
        {
          text: "📦 Очередь",
          callback_data:
            "queue",
        },
      ],

      [
        {
          text: state.postingEnabled
            ? "⛔ Стоп посты"
            : "▶️ Запустить посты",
          callback_data:
            "toggle_posts",
        },
      ],

      [
        {
          text: "🧩 Версия",
          callback_data:
            "version",
        },
        {
          text: "⚙️ Настройки",
          callback_data:
            "settings",
        },
      ],

      [
        {
          text: "🔄 Обновить",
          callback_data:
            "refresh",
        },
      ],
    ],
  };
}

/* =========================================================
   STATUS
========================================================= */

function buildStatus() {
  const posting =
    state.postingEnabled
      ? "🟢 ВКЛ"
      : "🔴 ВЫКЛ";

  let nextPost = "—";

  if (
    publicationQueue.length &&
    lastPublicationTime
  ) {
    const remaining =
      POST_INTERVAL_MS -
      (Date.now() -
        lastPublicationTime);

    nextPost =
      remaining <= 0
        ? "сейчас"
        : `через ${Math.ceil(
            remaining / 1000
          )} сек.`;
  }

  return (
    `🤖 <b>NEWS BOT</b>\n\n` +
    `🧩 Версия: <code>${VERSION}</code>\n` +
    `📤 Посты: ${posting}\n` +
    `📦 Очередь: <b>${publicationQueue.length}</b>\n` +
    `🕐 МСК: <b>${moscowTime()} МСК</b>\n\n` +

    `━━━━━━━━━━━━━━\n` +
    `📍 <b>ТЕКУЩИЙ ЭТАП</b>\n\n` +
    `${escapeHTML(
      state.currentStage
    )}\n` +
    `${
      state.currentDetails
        ? escapeHTML(
            state.currentDetails
          )
        : ""
    }\n\n` +

    `━━━━━━━━━━━━━━\n` +
    `📤 Следующий пост: <b>${nextPost}</b>\n` +
    `🔎 Найдено: ${state.totalFound || 0}\n` +
    `✅ Опубликовано: ${state.totalPosted || 0}\n` +
    `⏭ Пропущено: ${state.totalSkipped || 0}\n` +
    `❌ Ошибок: ${state.totalErrors || 0}\n\n` +

    `🕐 Последняя проверка:\n` +
    `${state.lastCheck
      ? moscowDate(
          state.lastCheck
        ) + " МСК"
      : "—"}\n\n` +

    `📤 Последний пост:\n` +
    `${state.lastPost
      ? moscowDate(
          state.lastPost
        ) + " МСК"
      : "—"}`
  );
}

/* =========================================================
   SOURCES
========================================================= */

function buildSources() {
  let text =
    `📡 <b>ИСТОЧНИКИ НОВОСТЕЙ</b>\n\n`;

  for (
    const source of FEEDS
  ) {
    const stats =
      state.sourceStats[
        source.id
      ] || {};

    const remembered =
      postedData.sources[
        source.id
      ] || [];

    text +=
      `${source.color} <b>${escapeHTML(
        source.name
      )}</b>\n` +

      `Статус: ${
        stats.status ||
        "⚪ Не проверялся"
      }\n` +

      `🔎 Найдено: ${
        stats.found || 0
      }\n` +

      `📤 Опубликовано: ${
        stats.posted || 0
      }\n` +

      `⏭ Дубли: ${
        stats.skipped || 0
      }\n` +

      `❌ Ошибки: ${
        stats.errors || 0
      }\n` +

      `💾 Запомнено: ${
        remembered.length
      }\n` +

      `🕐 ${
        stats.lastCheck
          ? moscowDate(
              stats.lastCheck
            ) + " МСК"
          : "—"
      }\n`;

    if (stats.lastError) {
      text +=
        `⚠️ ${escapeHTML(
          truncate(
            stats.lastError,
            150
          )
        )}\n`;
    }

    text += "\n";
  }

  text +=
    `━━━━━━━━━━━━━━\n` +
    `🟢 Работает\n` +
    `🔴 Ошибка\n` +
    `⚪️ Не проверялся`;

  return text;
}

/* =========================================================
   CATEGORIES MENU
========================================================= */

function categoriesKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🏛 Политика",
          callback_data:
            "cat_politics",
        },
        {
          text: "💰 Экономика",
          callback_data:
            "cat_economy",
        },
      ],

      [
        {
          text: "🌍 Мир",
          callback_data:
            "cat_world",
        },
        {
          text: "⚔️ Конфликты",
          callback_data:
            "cat_conflicts",
        },
      ],

      [
        {
          text: "💻 Технологии",
          callback_data:
            "cat_technology",
        },
        {
          text: "🔬 Наука",
          callback_data:
            "cat_science",
        },
      ],

      [
        {
          text: "🚀 Космос",
          callback_data:
            "cat_space",
        },
        {
          text: "🏎 Спорт",
          callback_data:
            "cat_sport",
        },
      ],

      [
        {
          text: "🎬 Культура",
          callback_data:
            "cat_culture",
        },
        {
          text: "🌐 Общество",
          callback_data:
            "cat_society",
        },
      ],

      [
        {
          text: "🚨 Происшествия",
          callback_data:
            "cat_incidents",
        },
      ],

      [
        {
          text: "📋 Все новости",
          callback_data:
            "cat_all",
        },
      ],

      [
        {
          text: "⬅️ Назад",
          callback_data:
            "back",
        },
      ],
    ],
  };
}

function getCategoryStats() {
  const stats = {};

  for (
    const category of CATEGORIES
  ) {
    stats[category.id] = 0;
  }

  for (
    const key of Object.keys(
      state.posts24h || {}
    )
  ) {
    const post =
      state.posts24h[key];

    if (
      post &&
      stats[post.category] !==
        undefined
    ) {
      stats[
        post.category
      ]++;
    }
  }

  return stats;
}

function buildCategories() {
  const stats =
    getCategoryStats();

  let text =
    `📂 <b>РАЗДЕЛЫ</b>\n\n`;

  for (
    const category of CATEGORIES
  ) {
    text +=
      `${category.emoji} <b>${category.name}</b> — ${stats[category.id] || 0} постов\n`;
  }

  return text;
}

/* =========================================================
   CATEGORY POSTS
========================================================= */

function buildCategoryPosts(
  categoryId
) {
  const category =
    categoryById(
      categoryId
    );

  const posts =
    Object.values(
      state.posts24h || {}
    )
      .filter(
        (post) =>
          post.category ===
          categoryId
      )
      .sort(
        (a, b) =>
          (b.reactions || 0) -
          (a.reactions || 0)
      )
      .slice(0, 10);

  if (!posts.length) {
    return (
      `${category?.emoji || "📂"} <b>${escapeHTML(
        category?.name ||
          "Раздел"
      )}</b>\n\n` +
      `За последние 24 часа публикаций нет.`
    );
  }

  let text =
    `${category.emoji} <b>${category.name.toUpperCase()}</b>\n\n`;

  posts.forEach(
    (post, index) => {
      const source =
        sourceById(
          post.source
        );

      text +=
        `${index + 1}. <b>${escapeHTML(
          truncate(
            post.title,
            120
          )
        )}</b>\n` +
        `${source?.color || "📡"} ${escapeHTML(
          source?.name ||
            post.source
        )} • ❤️ ${
          post.reactions || 0
        }\n\n`;
    }
  );

  return text;
}

/* =========================================================
   TOP 24 HOURS
========================================================= */

function clean24h() {
  const now =
    Date.now();

  const day =
    24 * 60 * 60 * 1000;

  for (
    const key of Object.keys(
      state.posts24h || {}
    )
  ) {
    const post =
      state.posts24h[key];

    if (
      !post ||
      now -
        new Date(
          post.publishedAt
        ).getTime() >
        day
    ) {
      delete state.posts24h[key];
    }
  }

  saveJSON(
    STATE_FILE,
    state
  );
}

function buildTop24() {
  clean24h();

  const posts =
    Object.values(
      state.posts24h || {}
    )
      .sort(
        (a, b) =>
          (b.reactions || 0) -
          (a.reactions || 0)
      )
      .slice(0, 10);

  if (!posts.length) {
    return (
      `🏆 <b>ТОП ЗА 24 ЧАСА</b>\n\n` +
      `Пока нет публикаций.`
    );
  }

  let text =
    `🏆 <b>ТОП НОВОСТЕЙ ЗА 24 ЧАСА</b>\n\n`;

  const medals = [
    "🥇",
    "🥈",
    "🥉",
  ];

  posts.forEach(
    (post, index) => {
      const source =
        sourceById(
          post.source
        );

      const category =
        categoryById(
          post.category
        );

      text +=
        `${medals[index] || `${index + 1}.`} ` +
        `<b>${escapeHTML(
          truncate(
            post.title,
            130
          )
        )}</b>\n` +

        `${source?.color || "📡"} ` +
        `${escapeHTML(
          source?.name ||
            post.source
        )}` +

        ` • ${category?.emoji || "📂"} ` +
        `${escapeHTML(
          category?.name ||
            "Новости"
        )}\n` +

        `❤️ <b>${
          post.reactions || 0
        }</b> реакций\n\n`;
    }
  );

  return text;
}

/* =========================================================
   STATISTICS
========================================================= */

function buildStatistics() {
  let text =
    `📈 <b>СТАТИСТИКА САЙТОВ</b>\n\n`;

  for (
    const source of FEEDS
  ) {
    const stats =
      state.sourceStats[
        source.id
      ] || {};

    text +=
      `${source.color} <b>${escapeHTML(
        source.name
      )}</b>\n` +
      `🔎 Найдено: ${
        stats.found || 0
      }\n` +
      `📤 Опубликовано: ${
        stats.posted || 0
      }\n` +
      `⏭ Дубли: ${
        stats.skipped || 0
      }\n` +
      `❌ Ошибки: ${
        stats.errors || 0
      }\n` +
      `📡 ${
        stats.status ||
        "⚪ Не проверялся"
      }\n` +
      `🕐 ${
        stats.lastCheck
          ? moscowDate(
              stats.lastCheck
            ) + " МСК"
          : "—"
      }\n\n`;
  }

  text +=
    `━━━━━━━━━━━━━━\n` +
    `📊 Всего найдено: ${
      state.totalFound || 0
    }\n` +
    `📤 Всего опубликовано: ${
      state.totalPosted || 0
    }\n` +
    `⏭ Всего пропущено: ${
      state.totalSkipped || 0
    }\n` +
    `❌ Всего ошибок: ${
      state.totalErrors || 0
    }`;

  return text;
}

/* =========================================================
   QUEUE
========================================================= */

function buildQueue() {
  if (
    !publicationQueue.length
  ) {
    return (
      `📦 <b>ОЧЕРЕДЬ</b>\n\n` +
      `Очередь пуста.\n\n` +
      `⏱ Ограничение: 1 пост в минуту`
    );
  }

  let text =
    `📦 <b>ОЧЕРЕДЬ ПУБЛИКАЦИЙ</b>\n\n` +
    `Всего: <b>${publicationQueue.length}</b>\n` +
    `⏱ 1 пост / 60 секунд\n\n`;

  publicationQueue
    .slice(0, 15)
    .forEach(
      (post, index) => {
        const source =
          sourceById(
            post.source
          );

        text +=
          `${index + 1}. <b>${escapeHTML(
            truncate(
              post.title,
              100
            )
          )}</b>\n` +
          `${source?.color || "📡"} ${
            source?.name ||
            post.source
          }\n\n`;
      }
    );

  return text;
}

/* =========================================================
   SETTINGS
========================================================= */

function buildSettings() {
  return (
    `⚙️ <b>НАСТРОЙКИ</b>\n\n` +

    `🧩 Версия: <code>${VERSION}</code>\n` +
    `📡 Источников: ${FEEDS.length}\n` +
    `🔄 Проверка RSS: каждые ${CHECK_INTERVAL_MIN} мин.\n` +
    `📤 Публикация: 1 пост / 60 сек.\n` +
    `💾 Память дублей: ${REMEMBER_PER_SOURCE} записей / источник, хранится ${Math.round(POSTED_MAX_AGE_MS / (24*60*60*1000))} дней\n` +
    `🕐 Не публикуем новости старше: ${Math.round(MAX_NEWS_AGE_MS / 60000)} мин.\n` +
    `🧠 Модель: <code>openai/gpt-oss-120b</code>\n` +
    `🕐 Часовой пояс: <code>Europe/Moscow</code>\n` +
    `🛡 Похожесть: ${
      SIMILARITY_THRESHOLD * 100
    }%\n\n` +

    `📂 Категории определяет ИИ.\n` +
    `🎨 Каждый источник имеет свой цвет.\n` +
    `📊 Статистика ведётся отдельно по каждому сайту.`
  );
}

/* =========================================================
   VERSION
========================================================= */

async function sendVersion() {
  if (!ADMIN_CHAT_ID) return;

  await telegram(
    "sendMessage",
    {
      chat_id:
        ADMIN_CHAT_ID,

      text:
        `🧩 <b>ВЕРСИЯ NEWS BOT</b>\n\n` +
        `🚀 Сейчас запущена:\n` +
        `<code>v${VERSION}</code>\n\n` +

        `🟢 Сервер работает\n` +
        `🧠 Groq подключён\n` +
        `📡 Источников: ${FEEDS.length}\n` +
        `📤 1 пост / минуту\n` +
        `🕐 МСК\n\n` +

        `Если ты видишь <code>v${VERSION}</code>, ` +
        `значит новая версия действительно запустилась на сервере.`,

      parse_mode: "HTML",

      reply_markup:
        mainKeyboard(),
    }
  );
}

/* =========================================================
   POST FORMAT
========================================================= */

function buildPost({
  title,
  summary,
  source,
  category,
  publishedAt,
}) {
  const categoryInfo =
    categoryById(
      category
    );

  return (
    `📰 <b>${escapeHTML(
      truncate(title, 250)
    )}</b>\n\n` +

    `${escapeHTML(
      summary
    )}\n\n` +

    `━━━━━━━━━━━━━━\n` +

    `${categoryInfo?.emoji || "📂"} <b>${
      categoryInfo?.name ||
      "Новости"
    }</b>\n` +

    `🕐 ${moscowTime(
      publishedAt
    )} МСК\n` +

    `📡 Источник: ${
      source.color
    } <b>${escapeHTML(
      source.name
    )}</b>`
  );
}

/* =========================================================
   GROQ
========================================================= */

const EDITOR_PROMPT = `
Ты редактор Telegram-новостного канала, который пишет для самой широкой аудитории —
включая людей без специального образования и без глубокого знания темы.

Тебе дают заголовок и содержание новости.

Нужно вернуть ТОЛЬКО JSON:

{
  "title": "...",
  "summary": "...",
  "category": "..."
}

category должен быть одним из:

politics
economy
world
conflicts
technology
science
space
sport
culture
society
incidents

Правила:

1. Заголовок должен быть коротким и понятным.
2. Заголовок не должен быть кликбейтом.
3. summary должен состоять из 3-5 коротких абзацев/предложений.
4. Не выдумывай факты.
5. Не повторяй заголовок в summary.
6. Убирай воду.
7. Сохраняй важные цифры, имена, даты и факты.
8. Если источник не даёт факта, не добавляй его от себя.
9. Пиши на русском языке.
10. Категория должна соответствовать главной теме новости.
11. Пиши МАКСИМАЛЬНО простым и понятным языком, короткими предложениями,
    как будто объясняешь новость человеку, который впервые слышит о теме.
12. Избегай канцелярита, штампов и сложных официальных формулировок
    ("осуществляется", "в рамках", "на фоне" и т.п.) — заменяй их простыми словами.
13. Если в новости есть специальный термин, аббревиатура, должность или название
    организации, которые могут быть непонятны обычному читателю — коротко поясни
    их прямо в тексте (в скобках или отдельной фразой), не превращая это в лекцию.
14. Не используй профессиональный жаргон без объяснения.
`;

async function processWithAI(
  title,
  content
) {
  const response =
    await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${GROQ_API_KEY}`,
        },

        body: JSON.stringify({
          model:
            "openai/gpt-oss-120b",

          messages: [
            {
              role: "system",
              content:
                EDITOR_PROMPT,
            },

            {
              role: "user",
              content:
                `Заголовок:\n${title}\n\n` +
                `Текст:\n${content}`,
            },
          ],

          temperature: 0.3,

          max_tokens: 700,

          response_format: {
            type: "json_object",
          },
        }),
      }
    );

  const data =
    await response.json();

  if (
    !data.choices ||
    !data.choices[0]
  ) {
    throw new Error(
      "Groq error: " +
        JSON.stringify(data)
    );
  }

  const result =
    JSON.parse(
      data.choices[0]
        .message.content
    );

  let category =
    result.category;

  if (
    !CATEGORIES.some(
      (item) =>
        item.id === category
    )
  ) {
    category = "world";
  }

  return {
    title:
      result.title ||
      title,

    summary:
      result.summary ||
      "",

    category,
  };
}

/* =========================================================
   MEDIA
========================================================= */

const parser =
  new Parser({
    timeout: 15000,

    customFields: {
      item: [
        [
          "media:content",
          "mediaContent",
          {
            keepArray:
              true,
          },
        ],

        [
          "media:thumbnail",
          "mediaThumbnail",
          {
            keepArray:
              true,
          },
        ],
      ],
    },
  });

function extractMedia(
  item
) {
  if (
    item.enclosure &&
    item.enclosure.url
  ) {
    const type =
      item.enclosure.type ||
      "";

    if (
      type.startsWith(
        "video"
      )
    ) {
      return {
        url:
          item.enclosure
            .url,
        kind: "video",
      };
    }

    if (
      type.startsWith(
        "image"
      )
    ) {
      return {
        url:
          item.enclosure
            .url,
        kind: "photo",
      };
    }
  }

  if (
    item.mediaContent &&
    item.mediaContent
      .length
  ) {
    const media =
      item.mediaContent[0]
        .$ || {};

    if (media.url) {
      const type =
        media.medium ||
        media.type ||
        "";

      return {
        url: media.url,
        kind:
          type.includes(
            "video"
          )
            ? "video"
            : "photo",
      };
    }
  }

  if (
    item.mediaThumbnail &&
    item.mediaThumbnail
      .length
  ) {
    const media =
      item.mediaThumbnail[0]
        .$ || {};

    if (media.url) {
      return {
        url: media.url,
        kind: "photo",
      };
    }
  }

  const html =
    item.content ||
    item["content:encoded"] ||
    "";

  const match =
    html.match(
      /<img[^>]+src=["']([^"']+)["']/
    );

  if (match) {
    return {
      url: match[1],
      kind: "photo",
    };
  }

  return null;
}

/* =========================================================
   FRESHNESS
========================================================= */

/* Возвращает дату публикации новости из RSS-записи, если её удалось
   определить. Если дата не пришла в фиде — вернёт null (тогда новость
   не отбрасывается по возрасту, т.к. мы не можем это проверить). */
function itemPublishedDate(item) {
  const raw =
    item.isoDate ||
    item.pubDate ||
    null;

  if (!raw) {
    return null;
  }

  const date = new Date(raw);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function isTooOld(item) {
  const published =
    itemPublishedDate(item);

  if (!published) {
    return false;
  }

  return (
    Date.now() -
      published.getTime() >
    MAX_NEWS_AGE_MS
  );
}

/* =========================================================
   DUPLICATES
========================================================= */

function normalizeWords(
  title
) {
  return (
    title || ""
  )
    .toLowerCase()
    .replace(
      /[^\p{L}\p{N}\s]/gu,
      ""
    )
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 3
    );
}

function similarity(
  a,
  b
) {
  const A = new Set(
    normalizeWords(a)
  );

  const B = new Set(
    normalizeWords(b)
  );

  if (!A.size || !B.size) {
    return 0;
  }

  const intersection =
    [...A].filter(
      (word) =>
        B.has(word)
    ).length;

  const union =
    new Set([
      ...A,
      ...B,
    ]).size;

  return (
    intersection /
    union
  );
}

/* Похожесть заголовков проверяем только по последним записям,
   а не по всей истории — иначе на большом окне памяти будут
   случайные ложные совпадения по общим словам */
function similarToRecent(
  sourceId,
  title
) {
  const recent =
    (postedData.sources[
      sourceId
    ] || []
    ).slice(-SIMILARITY_CHECK_WINDOW);

  return recent.some(
    (post) =>
      similarity(
        title,
        post.title
      ) >=
      SIMILARITY_THRESHOLD
  );
}

/* Есть ли эта ссылка уже в нашей истории (это и есть "база того,
   что публиковалось") */
function alreadyKnownLink(
  sourceId,
  link
) {
  return (
    postedData.sources[
      sourceId
    ] || []
  ).some(
    (post) => post.link === link
  );
}

function pruneOldPosted() {
  const now = Date.now();

  for (const source of FEEDS) {
    const list =
      postedData.sources[
        source.id
      ] || [];

    postedData.sources[
      source.id
    ] = list
      .filter((post) => {
        const time = post.time
          ? new Date(
              post.time
            ).getTime()
          : 0;

        return (
          now - time <=
          POSTED_MAX_AGE_MS
        );
      })
      .slice(
        -REMEMBER_PER_SOURCE
      );
  }

  saveJSON(
    POSTED_FILE,
    postedData
  );
}

function rememberPost(
  sourceId,
  item
) {
  if (
    !postedData.sources[
      sourceId
    ]
  ) {
    postedData.sources[
      sourceId
    ] = [];
  }

  postedData.sources[
    sourceId
  ].push({
    link: item.link,
    title:
      item.title || "",
    time:
      new Date().toISOString(),
  });

  postedData.sources[
    sourceId
  ] =
    postedData.sources[
      sourceId
    ].slice(
      -REMEMBER_PER_SOURCE
    );

  saveJSON(
    POSTED_FILE,
    postedData
  );
}

/* =========================================================
   QUEUE
========================================================= */

function alreadyQueued(
  link
) {
  return publicationQueue.some(
    (post) =>
      post.link === link
  );
}

function queuePost(post) {
  if (
    alreadyQueued(
      post.link
    )
  ) {
    return false;
  }

  publicationQueue.push(
    post
  );

  console.log(
    `📦 В очередь: ${post.title}`
  );

  updateAdminStatus().catch(
    () => {}
  );

  return true;
}

/* =========================================================
   SEND CHANNEL
========================================================= */

async function sendChannel(
  text,
  media
) {
  try {
    if (
      media &&
      media.kind ===
        "photo"
    ) {
      return await telegram(
        "sendPhoto",
        {
          chat_id:
            CHANNEL_ID,

          photo:
            media.url,

          caption:
            text.slice(
              0,
              1024
            ),

          parse_mode:
            "HTML",
        }
      );
    }

    if (
      media &&
      media.kind ===
        "video"
    ) {
      return await telegram(
        "sendVideo",
        {
          chat_id:
            CHANNEL_ID,

          video:
            media.url,

          caption:
            text.slice(
              0,
              1024
            ),

          parse_mode:
            "HTML",
        }
      );
    }

    return await telegram(
      "sendMessage",
      {
        chat_id:
          CHANNEL_ID,

        text,

        parse_mode:
          "HTML",

        disable_web_page_preview:
          true,
      }
    );
  } catch (error) {
    if (media) {
      console.warn(
        "⚠️ Медиа не отправилось:",
        error.message
      );

      return await telegram(
        "sendMessage",
        {
          chat_id:
            CHANNEL_ID,

          text,

          parse_mode:
            "HTML",

          disable_web_page_preview:
            true,
        }
      );
    }

    throw error;
  }
}

/* =========================================================
   PUBLICATION WORKER
========================================================= */

async function publicationWorker() {
  if (
    publisherRunning
  ) {
    return;
  }

  if (
    !state.postingEnabled
  ) {
    setStage(
      "⛔ Публикация остановлена",
      "Ожидание команды «Запустить посты»"
    );

    return;
  }

  if (
    !publicationQueue.length
  ) {
    return;
  }

  publisherRunning =
    true;

  try {
    while (
      publicationQueue.length &&
      state.postingEnabled
    ) {
      const elapsed =
        lastPublicationTime
          ? Date.now() -
            lastPublicationTime
          : POST_INTERVAL_MS;

      const wait =
        POST_INTERVAL_MS -
        elapsed;

      if (wait > 0) {
        setStage(
          "⏳ Ожидание",
          `Следующий пост через ${Math.ceil(
            wait / 1000
          )} сек.`
        );

        await sleep(
          wait
        );
      }

      if (
        !state.postingEnabled
      ) {
        break;
      }

      const post =
        publicationQueue.shift();

      if (!post) {
        continue;
      }

      const source =
        sourceById(
          post.source
        );

      setStage(
        "📤 Публикация",
        `${source?.color || "📡"} ${source?.name || post.source}`
      );

      try {
        const result =
          await sendChannel(
            post.text,
            post.media
          );

        const messageId =
          result.message_id;

        const now =
          new Date().toISOString();

        state.lastPost =
          now;

        state.totalPosted =
          (state.totalPosted ||
            0) + 1;

        state.sourceStats[
          post.source
        ].posted =
          (state.sourceStats[
            post.source
          ].posted || 0) + 1;

        /*
           Для топа 24ч.
           Реакции позже обновляются через
           message_reaction_count, если Telegram
           присылает обновление боту.
        */
        state.posts24h[
          String(messageId)
        ] = {
          messageId,

          title:
            post.title,

          source:
            post.source,

          category:
            post.category,

          publishedAt:
            now,

          reactions: 0,
        };

        lastPublicationTime =
          Date.now();

        saveJSON(
          STATE_FILE,
          state
        );

        console.log(
          `✅ Опубликовано: ${post.title}`
        );
      } catch (error) {
        state.totalErrors =
          (state.totalErrors ||
            0) + 1;

        state.sourceStats[
          post.source
        ].errors =
          (state.sourceStats[
            post.source
          ].errors || 0) + 1;

        saveJSON(
          STATE_FILE,
          state
        );

        console.error(
          "❌ Ошибка публикации:",
          error.message
        );
      }

      updateAdminStatus().catch(
        () => {}
      );
    }
  } finally {
    publisherRunning =
      false;

    if (
      publicationQueue.length
    ) {
      setStage(
        "📦 Очередь",
        `${publicationQueue.length} новостей ожидают публикации`
      );
    } else {
      setStage(
        "🟢 Ожидание",
        "Новых публикаций в очереди нет"
      );
    }
  }
}

/* =========================================================
   INITIAL SYNC
========================================================= */

async function initialSync() {
  setStage(
    "🛡 Первичная синхронизация",
    "Запоминаю последние новости, без публикации старого архива"
  );

  for (
    const source of FEEDS
  ) {
    try {
      const feed =
        await parser.parseURL(
          source.url
        );

      const items =
        feed.items.slice(
          0,
          20
        );

      postedData.sources[
        source.id
      ] = items
        .filter(
          (item) =>
            item.link
        )
        .map(
          (item) => ({
            link:
              item.link,

            title:
              item.title ||
              "",

            time:
              new Date().toISOString(),
          })
        );

      state.sourceStats[
        source.id
      ] = {
        ...state.sourceStats[
          source.id
        ],

        status:
          "🟢 Работает",

        found:
          items.length,

        lastCheck:
          new Date().toISOString(),

        lastError:
          null,
      };
    } catch (error) {
      state.sourceStats[
        source.id
      ] = {
        ...state.sourceStats[
          source.id
        ],

        status:
          "🔴 Ошибка",

        lastCheck:
          new Date().toISOString(),

        lastError:
          error.message,

        errors:
          (state.sourceStats[
            source.id
          ].errors || 0) + 1,
      };
    }
  }

  saveJSON(
    POSTED_FILE,
    postedData
  );

  state.initialized =
    true;

  state.lastCheck =
    new Date().toISOString();

  saveJSON(
    STATE_FILE,
    state
  );

  setStage(
    "✅ Синхронизация завершена",
    "Теперь публикуются только новые новости"
  );
}

/* =========================================================
   CHECK FEEDS
========================================================= */

async function checkFeeds() {
  if (isChecking) {
    return;
  }

  isChecking = true;

  try {
    if (
      !state.initialized
    ) {
      await initialSync();
      return;
    }

    setStage(
      "🔎 Поиск новостей",
      `Проверяю ${FEEDS.length} источников`
    );

    for (
      const source of FEEDS
    ) {
      setStage(
        "📡 Проверка источника",
        `${source.color} ${source.name}`
      );

      try {
        const feed =
          await parser.parseURL(
            source.url
          );

        const items =
          feed.items.slice(
            0,
            10
          );

        const stats =
          state.sourceStats[
            source.id
          ];

        stats.status =
          "🟢 Работает";

        stats.found =
          items.length;

        stats.lastCheck =
          new Date().toISOString();

        stats.lastError =
          null;

        /*
           Сравниваем со всей сохранённой историей ссылок по источнику
           (это и есть наша "база того, что уже публиковалось/видели").
        */

        for (
          const item of items
        ) {
          if (
            !item.link ||
            !item.title
          ) {
            continue;
          }

          const known =
            alreadyKnownLink(
              source.id,
              item.link
            );

          if (known) {
            continue;
          }

          if (
            alreadyQueued(
              item.link
            )
          ) {
            continue;
          }

          state.totalFound =
            (state.totalFound ||
              0) + 1;

          stats.found =
            (stats.found ||
              0);

          /*
             Слишком старая новость (по дате из RSS) — запоминаем,
             чтобы не проверять её снова каждые несколько минут,
             но не публикуем.
          */

          if (isTooOld(item)) {
            stats.skipped =
              (stats.skipped ||
                0) + 1;

            state.totalSkipped =
              (state.totalSkipped ||
                0) + 1;

            rememberPost(
              source.id,
              item
            );

            continue;
          }

          setStage(
            "🆕 Новая новость",
            `${source.color} ${source.name}: ${truncate(
              item.title,
              100
            )}`
          );

          /*
             Проверка похожести.
          */

          if (
            similarToRecent(
              source.id,
              item.title
            )
          ) {
            stats.skipped =
              (stats.skipped ||
                0) + 1;

            state.totalSkipped =
              (state.totalSkipped ||
                0) + 1;

            rememberPost(
              source.id,
              item
            );

            continue;
          }

          /*
             ИИ.
          */

          setStage(
            "🧠 Обработка ИИ",
            `${source.color} ${source.name}`
          );

          try {
            const ai =
              await processWithAI(
                item.title,
                item.contentSnippet ||
                  item.content ||
                  item.title
              );

            const text =
              buildPost({
                title:
                  ai.title,

                summary:
                  ai.summary,

                source,

                category:
                  ai.category,

                publishedAt:
                  itemPublishedDate(
                    item
                  ) ||
                  new Date(),
              });

            const media =
              extractMedia(
                item
              );

            /*
               Запоминаем сразу,
               чтобы один и тот же RSS item
               не добавился снова в очередь.
            */

            rememberPost(
              source.id,
              item
            );

            queuePost({
              link:
                item.link,

              title:
                ai.title,

              source:
                source.id,

              category:
                ai.category,

              text,

              media,
            });
          } catch (error) {
            stats.errors =
              (stats.errors ||
                0) + 1;

            state.totalErrors =
              (state.totalErrors ||
                0) + 1;

            console.error(
              `❌ AI ${source.name}:`,
              error.message
            );
          }
        }
      } catch (error) {
        const stats =
          state.sourceStats[
            source.id
          ];

        stats.status =
          "🔴 Ошибка";

        stats.lastCheck =
          new Date().toISOString();

        stats.lastError =
          error.message;

        stats.errors =
          (stats.errors ||
            0) + 1;

        state.totalErrors =
          (state.totalErrors ||
            0) + 1;

        console.error(
          `❌ RSS ${source.name}:`,
          error.message
        );
      }
    }

    state.lastCheck =
      new Date().toISOString();

    saveJSON(
      STATE_FILE,
      state
    );

    pruneOldPosted();

    if (
      publicationQueue.length
    ) {
      setStage(
        "📦 Новости в очереди",
        `${publicationQueue.length} подготовлено к публикации`
      );

      publicationWorker();
    } else {
      setStage(
        "🟢 Ожидание",
        "Новых новостей не найдено"
      );
    }
  } finally {
    isChecking =
      false;

    saveJSON(
      STATE_FILE,
      state
    );

    updateAdminStatus().catch(
      () => {}
    );
  }
}

/* =========================================================
   ADMIN STATUS MESSAGE
========================================================= */

async function updateAdminStatus() {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    const text =
      buildStatus();

    if (
      !adminStatusMessageId
    ) {
      const result =
        await telegram(
          "sendMessage",
          {
            chat_id:
              ADMIN_CHAT_ID,

            text,

            parse_mode:
              "HTML",

            reply_markup:
              mainKeyboard(),
          }
        );

      adminStatusMessageId =
        result.message_id;

      return;
    }

    await telegram(
      "editMessageText",
      {
        chat_id:
          ADMIN_CHAT_ID,

        message_id:
          adminStatusMessageId,

        text,

        parse_mode:
          "HTML",

        reply_markup:
          mainKeyboard(),
      }
    );
  } catch (error) {
    /* Если сообщение не найдено/удалено или его нельзя отредактировать —
       забываем id, чтобы в следующий раз отправить новое сообщение.
       "message is not modified" — это не ошибка, просто текст не изменился. */
    if (
      !String(
        error.message || ""
      ).includes(
        "message is not modified"
      )
    ) {
      adminStatusMessageId =
        null;
    }
  }
}

/* =========================================================
   ADMIN STARTUP
========================================================= */

async function notifyStartup() {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    const result =
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            `🚀 <b>NEWS BOT ОБНОВЛЁН</b>\n\n` +

            `🧩 Версия:\n` +
            `<code>v${VERSION}</code>\n\n` +

            `🟢 Сервер запущен\n` +
            `🧠 ИИ подключён\n` +
            `📡 Источников: ${FEEDS.length}\n` +
            `📤 Лимит: 1 пост / минуту\n` +
            `💾 Память: ${REMEMBER_PER_SOURCE} записей / источник (до ${Math.round(POSTED_MAX_AGE_MS / (24*60*60*1000))} дней)\n` +
            `🕐 Время: МСК\n\n` +

            `Если здесь отображается <code>v${VERSION}</code>, ` +
            `обновление действительно прошло.`,

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

    adminStatusMessageId =
      result.message_id;
  } catch (error) {
    console.error(
      "Ошибка уведомления:",
      error.message
    );
  }
}

/* =========================================================
   CALLBACKS
========================================================= */

async function handleCallback(
  callback
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  if (
    String(
      callback.message?.chat
        ?.id
    ) !==
    String(ADMIN_CHAT_ID)
  ) {
    return;
  }

  const data =
    callback.data;

  /*
     Раньше answerCallbackQuery и вся логика ниже ничем не были
     обёрнуты: если отправка/редактирование сообщения падало с
     ошибкой (например, слишком длинный текст или проблема сети),
     кнопка визуально "крутилась" и просто ничего не происходило,
     без каких-либо следов в чате. Теперь любая ошибка ловится и
     присылается админу текстом, плюс попадает в лог.
  */
  try {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id,
      }
    );
  } catch (error) {
    console.error(
      "answerCallbackQuery:",
      error.message
    );
  }

  try {
    if (data === "status") {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildStatus(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "sources"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildSources(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "categories"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildCategories(),

          parse_mode:
            "HTML",

          reply_markup:
            categoriesKeyboard(),
        }
      );

      return;
    }

    if (
      data.startsWith(
        "cat_"
      )
    ) {
      const categoryId =
        data.replace(
          "cat_",
          ""
        );

      if (
        categoryId ===
        "all"
      ) {
        await telegram(
          "sendMessage",
          {
            chat_id:
              ADMIN_CHAT_ID,

            text:
              buildTop24(),

            parse_mode:
              "HTML",

            reply_markup:
              mainKeyboard(),
          }
        );

        return;
      }

      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildCategoryPosts(
              categoryId
            ),

          parse_mode:
            "HTML",

          reply_markup:
            categoriesKeyboard(),
        }
      );

      return;
    }

    if (
      data === "top24"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildTop24(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "statistics"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildStatistics(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "queue"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildQueue(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data ===
      "toggle_posts"
    ) {
      state.postingEnabled =
        !state.postingEnabled;

      saveJSON(
        STATE_FILE,
        state
      );

      if (
        state.postingEnabled
      ) {
        setStage(
          "▶️ Публикация включена",
          `${publicationQueue.length} новостей в очереди`
        );

        publicationWorker();
      } else {
        setStage(
          "⛔ Публикация остановлена",
          "Новые новости продолжают собираться"
        );
      }

      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            state.postingEnabled
              ? `▶️ <b>ПУБЛИКАЦИЯ ВКЛЮЧЕНА</b>\n\nОчередь: ${publicationQueue.length}`
              : `⛔ <b>ПУБЛИКАЦИЯ ОСТАНОВЛЕНА</b>\n\nНовости продолжают проверяться и попадать в очередь.`,

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "version"
    ) {
      await sendVersion();
      return;
    }

    if (
      data === "settings"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            buildSettings(),

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      data === "refresh"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            `🔄 <b>Проверка запущена</b>\n\n` +
            `Смотри раздел «Статус», чтобы видеть текущий этап.`,

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      checkFeeds();

      return;
    }

    if (
      data === "back"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            `🤖 <b>NEWS BOT</b>\n\nВыбери раздел:`,

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );
    }
  } catch (error) {
    console.error(
      `❌ Кнопка "${data}":`,
      error.message
    );

    try {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            `❌ Ошибка при обработке кнопки «${escapeHTML(
              data
            )}»:\n<code>${escapeHTML(
              truncate(
                error.message,
                500
              )
            )}</code>`,

          parse_mode:
            "HTML",
        }
      );
    } catch {}
  }
}

/* =========================================================
   ADMIN COMMANDS
========================================================= */

async function handleAdminMessage(
  message
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  if (
    String(
      message.chat.id
    ) !==
    String(ADMIN_CHAT_ID)
  ) {
    return;
  }

  const text =
    (
      message.text || ""
    ).trim();

  try {
    if (
      text === "/start" ||
      text === "/menu"
    ) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            `🤖 <b>NEWS BOT v${VERSION}</b>\n\nВыбери раздел:`,

          parse_mode:
            "HTML",

          reply_markup:
            mainKeyboard(),
        }
      );

      return;
    }

    if (
      text === "/check"
    ) {
      checkFeeds();

      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            "🔎 Проверка запущена.",

          reply_markup:
            mainKeyboard(),
        }
      );
    }
  } catch (error) {
    console.error(
      "❌ Команда:",
      error.message
    );
  }
}

/* =========================================================
   REACTIONS
========================================================= */

/*
   Telegram может присылать message_reaction_count
   для сообщений канала.

   Мы ищем соответствующий message_id
   среди опубликованных за последние 24 часа.
*/

function totalReactions(
  reactionArray
) {
  if (
    !Array.isArray(
      reactionArray
    )
  ) {
    return 0;
  }

  return reactionArray.reduce(
    (sum, reaction) =>
      sum +
      Number(
        reaction.total_count ||
          0
      ),
    0
  );
}

function handleReactionUpdate(
  update
) {
  const data =
    update.message_reaction_count;

  if (!data) {
    return;
  }

  const messageId =
    String(
      data.message_id
    );

  if (
    state.posts24h[
      messageId
    ]
  ) {
    state.posts24h[
      messageId
    ].reactions =
      totalReactions(
        data.reactions
      );

    saveJSON(
      STATE_FILE,
      state
    );
  }
}

/* =========================================================
   TELEGRAM POLLING
========================================================= */

async function adminPolling() {
  if (
    adminPollingRunning ||
    !BOT_TOKEN
  ) {
    return;
  }

  adminPollingRunning =
    true;

  /*
     Получаем последний update,
     чтобы не обрабатывать старые команды.
  */

  try {
    const updates =
      await telegram(
        "getUpdates",
        {
          offset: -1,
          limit: 1,
          timeout: 1,
          allowed_updates: [
            "message",
            "callback_query",
            "message_reaction_count",
          ],
        }
      );

    if (
      updates &&
      updates.length
    ) {
      telegramUpdateOffset =
        updates[
          updates.length - 1
        ].update_id;
    }
  } catch {}

  while (true) {
    try {
      const updates =
        await telegram(
          "getUpdates",
          {
            offset:
              telegramUpdateOffset +
              1,

            timeout: 25,

            allowed_updates: [
              "message",
              "callback_query",
              "message_reaction_count",
            ],
          }
        );

      for (
        const update of
          updates || []
      ) {
        telegramUpdateOffset =
          update.update_id;

        if (
          update.message
        ) {
          await handleAdminMessage(
            update.message
          );
        }

        if (
          update.callback_query
        ) {
          await handleCallback(
            update.callback_query
          );
        }

        if (
          update.message_reaction_count
        ) {
          handleReactionUpdate(
            update
          );
        }
      }
    } catch (error) {
      console.error(
        "Telegram polling:",
        error.message
      );

      await sleep(
        5000
      );
    }
  }
}

/* =========================================================
   CLEAN TOP
========================================================= */

setInterval(
  () => {
    clean24h();
  },
  10 * 60 * 1000
);

/* =========================================================
   HTTP
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      `News Bot v${VERSION} is running.`
    );
  }
);

app.get(
  "/status",
  (req, res) => {
    res.json({
      version:
        VERSION,

      postingEnabled:
        state.postingEnabled,

      checking:
        isChecking,

      stage:
        state.currentStage,

      details:
        state.currentDetails,

      queue:
        publicationQueue.length,

      sources:
        FEEDS.length,

      totalFound:
        state.totalFound ||
        0,

      totalPosted:
        state.totalPosted ||
        0,

      totalSkipped:
        state.totalSkipped ||
        0,

      totalErrors:
        state.totalErrors ||
        0,

      lastCheck:
        state.lastCheck,

      lastPost:
        state.lastPost,
    });
  }
);

app.get(
  "/sources",
  (req, res) => {
    res.json(
      FEEDS.map(
        (source) => ({
          id:
            source.id,

          name:
            source.name,

          color:
            source.color,

          url:
            source.url,

          stats:
            state.sourceStats[
              source.id
            ],
        })
      )
    );
  }
);

app.get(
  "/run-now",
  (req, res) => {
    if (
      RUN_SECRET &&
      req.query.secret !==
        RUN_SECRET
    ) {
      return res
        .status(403)
        .send(
          "forbidden"
        );
    }

    if (isChecking) {
      return res.send(
        "Проверка уже выполняется."
      );
    }

    checkFeeds();

    res.send(
      `Проверка запущена. News Bot v${VERSION}`
    );
  }
);

/* =========================================================
   START
========================================================= */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  async () => {
    console.log(
      "======================================"
    );

    console.log(
      `🤖 NEWS BOT v${VERSION}`
    );

    console.log(
      `📡 Sources: ${FEEDS.length}`
    );

    console.log(
      "📤 Limit: 1 post / 60 sec"
    );

    console.log(
      `🕐 Timezone: ${TIMEZONE}`
    );

    console.log(
      `💾 Remember: ${REMEMBER_PER_SOURCE} per source (${Math.round(POSTED_MAX_AGE_MS / (24*60*60*1000))}d)`
    );

    console.log(
      "======================================"
    );

    await notifyStartup();

    setStage(
      "🚀 Запуск",
      `News Bot v${VERSION}`
    );

    /*
       Сначала синхронизация,
       затем проверка.
    */

    await checkFeeds();

    /*
       Telegram управление.
    */

    adminPolling();

    /*
       Регулярная проверка.
    */

    setInterval(
      () => {
        checkFeeds();
      },
      CHECK_INTERVAL_MIN *
        60 *
        1000
    );
  }
);
