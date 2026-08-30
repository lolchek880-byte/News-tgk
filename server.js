const express = require("express");
const fetch = require("node-fetch");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

/*
=========================================================
AI NEWS BOT
VERSION 0.5.0
=========================================================

Что есть:

- RSS-источники
- Groq AI
- Перевод/редактирование новостей
- Защита от дублей
- Очередь публикаций
- Максимум 1 пост в минуту
- Защита от повторной публикации после restart
- Админ-меню в Telegram
- Статус текущего этапа
- Список источников
- Статистика
- Версия бота
- Уведомление при запуске
- /status
- /sources
- /version
- /stats
- /check
- /help
- HTTP /run-now
- HTTP /status
- HTTP /sources

=========================================================
*/

const app = express();

/* =======================================================
   VERSION
======================================================= */

const VERSION = "0.5.0";

/* =======================================================
   ENV
======================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const CHECK_INTERVAL_MIN = parseInt(
  process.env.CHECK_INTERVAL_MIN || "30",
  10
);

const RUN_SECRET =
  process.env.RUN_SECRET || null;

const ADMIN_CHAT_ID =
  process.env.ADMIN_CHAT_ID || null;

const SIMILARITY_THRESHOLD = parseFloat(
  process.env.SIMILARITY_THRESHOLD || "0.5"
);

/*
   Жёсткий лимит публикаций:
   1 публикация минимум каждые 60 секунд.
*/
const POST_INTERVAL_MS = 60 * 1000;

/*
   Сколько последних записей RSS проверяем
   с каждого источника.
*/
const ITEMS_PER_FEED = 5;

/*
   Сколько записей сохраняем в posted.json.
*/
const MAX_POSTED_RECORDS = 1000;

const API_URL =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

/* =======================================================
   ENV CHECK
======================================================= */

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не задан");
}

if (!CHANNEL_ID) {
  console.error("❌ CHANNEL_ID не задан");
}

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY не задан");
}

if (!ADMIN_CHAT_ID) {
  console.warn(
    "⚠️ ADMIN_CHAT_ID не задан. Админ-меню и уведомления отключены."
  );
}

/* =======================================================
   RSS PARSER
======================================================= */

const parser = new Parser({
  timeout: 15000,

  customFields: {
    item: [
      [
        "media:content",
        "mediaContent",
        {
          keepArray: true,
        },
      ],

      [
        "media:thumbnail",
        "mediaThumbnail",
        {
          keepArray: true,
        },
      ],
    ],
  },
});

/* =======================================================
   NEWS SOURCES
======================================================= */

const FEEDS = [
  {
    url: "https://www.mk.ru/rss/news/index.xml",
    name: "МК",
  },

  {
    url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
    name: "РБК",
  },

  {
    url: "https://rtvi.com/feed/",
    name: "RTVI",
  },

  {
    url: "https://www.gazeta.ru/export/rss/first.xml",
    name: "Газета.Ru",
  },

  {
    url: "https://tass.ru/rss/v2.xml?section=politics",
    name: "ТАСС",
  },

  {
    url: "https://news.rambler.ru/rss/politics/",
    name: "Рамблер",
  },
];

/* =======================================================
   FILE STORAGE
======================================================= */

const DATA_DIR =
  path.join(__dirname, "data");

const POSTED_FILE =
  path.join(DATA_DIR, "posted.json");

const STATE_FILE =
  path.join(DATA_DIR, "state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

function ensureFile(file, data) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }
}

ensureFile(
  POSTED_FILE,
  []
);

ensureFile(
  STATE_FILE,
  {
    initialized: false,
    version: VERSION,
    startedAt: null,
    lastCheck: null,
    lastPost: null,

    totalFound: 0,
    totalPosted: 0,
    totalSkipped: 0,
    totalErrors: 0,

    sourceStats: {},
  }
);

function loadJSON(file, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      `Ошибка чтения ${file}:`,
      error.message
    );

    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.error(
      `Ошибка записи ${file}:`,
      error.message
    );
  }
}

function loadPosted() {
  return loadJSON(
    POSTED_FILE,
    []
  );
}

function savePosted(list) {
  const trimmed =
    list.slice(
      -MAX_POSTED_RECORDS
    );

  saveJSON(
    POSTED_FILE,
    trimmed
  );
}

function loadState() {
  return loadJSON(
    STATE_FILE,
    {}
  );
}

function saveState() {
  saveJSON(
    STATE_FILE,
    state
  );
}

/* =======================================================
   STATE
======================================================= */

let state =
  loadState();

state.version =
  VERSION;

state.startedAt =
  new Date().toISOString();

if (!state.sourceStats) {
  state.sourceStats = {};
}

for (const source of FEEDS) {
  if (
    !state.sourceStats[
      source.name
    ]
  ) {
    state.sourceStats[
      source.name
    ] = {
      status: "⚪ Не проверялся",
      found: 0,
      lastCheck: null,
      error: null,
    };
  }
}

saveState();

/* =======================================================
   RUNTIME
======================================================= */

let isChecking = false;

let isInitialized =
  Boolean(state.initialized);

let publisherRunning = false;

let lastStage =
  "🚀 Запуск";

let lastStageDetails =
  "Подготовка бота";

let adminStatusMessageId =
  null;

/*
   Очередь публикаций.
*/
const publicationQueue = [];

/*
   Последнее время публикации.
*/
let lastPublicationTime =
  state.lastPost
    ? new Date(
        state.lastPost
      ).getTime()
    : 0;

/*
   Telegram polling offset.
*/
let telegramUpdateOffset = 0;

let adminPollingRunning =
  false;

/* =======================================================
   UTILS
======================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function formatDate(date) {
  if (!date) {
    return "—";
  }

  try {
    return new Date(
      date
    ).toLocaleString(
      "ru-RU",
      {
        timeZone:
          "Europe/Moscow",
        hour12: false,
      }
    );
  } catch {
    return "—";
  }
}

function escapeHTML(text) {
  return String(
    text || ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    );
}

/* =======================================================
   STAGE SYSTEM
======================================================= */

function setStage(
  stage,
  details = ""
) {
  lastStage =
    stage;

  lastStageDetails =
    details;

  console.log(
    `[STAGE] ${stage}` +
    (
      details
        ? ` — ${details}`
        : ""
    )
  );

  updateAdminStatus()
    .catch(() => {});
}

/* =======================================================
   TELEGRAM API
======================================================= */

async function telegram(
  method,
  body = {}
) {
  if (!BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN не задан"
    );
  }

  const response =
    await fetch(
      `${API_URL}/${method}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(body),
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

/* =======================================================
   ADMIN STATUS
======================================================= */

function getQueueStatus() {
  if (
    publicationQueue.length === 0
  ) {
    return "📦 Очередь: 0";
  }

  return (
    `📦 Очередь: ` +
    `${publicationQueue.length}`
  );
}

function getNextPublicationText() {
  if (
    publicationQueue.length === 0
  ) {
    return "—";
  }

  if (!lastPublicationTime) {
    return "сейчас";
  }

  const elapsed =
    Date.now() -
    lastPublicationTime;

  const remaining =
    Math.max(
      0,
      POST_INTERVAL_MS -
        elapsed
    );

  if (remaining <= 0) {
    return "сейчас";
  }

  return (
    `через ${Math.ceil(
      remaining / 1000
    )} сек.`
  );
}

function buildStatusText() {
  const status =
    isChecking
      ? "🟢 Проверка выполняется"
      : "⚪ Ожидание";

  return (
    `🤖 <b>AI News Bot</b>\n\n` +

    `🧩 Версия: ` +
    `<code>${VERSION}</code>\n` +

    `${status}\n\n` +

    `📍 <b>Текущий этап</b>\n` +
    `${escapeHTML(lastStage)}\n` +

    (
      lastStageDetails
        ? `${escapeHTML(
            lastStageDetails
          )}\n`
        : ""
    ) +

    `\n` +

    `${getQueueStatus()}\n` +

    `📤 Следующая публикация: ` +
    `${getNextPublicationText()}\n\n` +

    `📰 Найдено: ` +
    `${state.totalFound || 0}\n` +

    `✅ Опубликовано: ` +
    `${state.totalPosted || 0}\n` +

    `⏭ Пропущено: ` +
    `${state.totalSkipped || 0}\n` +

    `❌ Ошибок: ` +
    `${state.totalErrors || 0}\n\n` +

    `🕐 Последняя проверка:\n` +
    `${formatDate(
      state.lastCheck
    )}\n\n` +

    `📤 Последняя публикация:\n` +
    `${formatDate(
      state.lastPost
    )}`
  );
}

async function updateAdminStatus() {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    const text =
      buildStatusText();

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

            disable_web_page_preview:
              true,
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

        disable_web_page_preview:
          true,
      }
    );
  } catch (error) {
    /*
       Если сообщение невозможно отредактировать,
       просто сбрасываем ID. Следующая попытка
       создаст новое сообщение.
    */

    console.error(
      "Admin status error:",
      error.message
    );

    adminStatusMessageId =
      null;
  }
}

/* =======================================================
   ADMIN MENU
======================================================= */

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "📊 Статус",
          callback_data:
            "admin_status",
        },

        {
          text: "📡 Источники",
          callback_data:
            "admin_sources",
        },
      ],

      [
        {
          text: "🔎 Проверить сейчас",
          callback_data:
            "admin_check",
        },

        {
          text: "📈 Статистика",
          callback_data:
            "admin_stats",
        },
      ],

      [
        {
          text: "🧩 Версия",
          callback_data:
            "admin_version",
        },

        {
          text: "🔄 Обновить",
          callback_data:
            "admin_refresh",
        },
      ],
    ],
  };
}

async function sendAdminMenu() {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          `🤖 <b>AI News Bot</b>\n\n` +
          `🧩 Версия: <code>${VERSION}</code>\n` +
          `🟢 Бот работает.\n\n` +
          `Выбери действие:`,
        
        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "Admin menu error:",
      error.message
    );
  }
}

/* =======================================================
   SOURCES
======================================================= */

function buildSourcesText() {
  let text =
    `📡 <b>ИСТОЧНИКИ НОВОСТЕЙ</b>\n\n`;

  FEEDS.forEach(
    (source, index) => {
      const stats =
        state.sourceStats[
          source.name
        ] || {};

      text +=
        `<b>${index + 1}. ` +
        `${escapeHTML(
          source.name
        )}</b>\n`;

      text +=
        `${stats.status || "⚪ Не проверялся"}\n`;

      text +=
        `🔎 Найдено: ` +
        `${stats.found || 0}\n`;

      text +=
        `🕐 Проверка: ` +
        `${formatDate(
          stats.lastCheck
        )}\n`;

      if (stats.error) {
        text +=
          `❌ Ошибка: ` +
          `${escapeHTML(
            stats.error
          )}\n`;
      }

      text += "\n";
    }
  );

  return text;
}

async function sendSourcesToAdmin(
  callbackQueryId = null
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    if (callbackQueryId) {
      await telegram(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackQueryId,
        }
      );
    }

    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          buildSourcesText(),

        parse_mode:
          "HTML",

        disable_web_page_preview:
          true,

        reply_markup:
          adminKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "Sources error:",
      error.message
    );
  }
}

/* =======================================================
   STATISTICS
======================================================= */

function buildStatsText() {
  const queue =
    publicationQueue.length;

  return (
    `📈 <b>СТАТИСТИКА</b>\n\n` +

    `🧩 Версия: ` +
    `<code>${VERSION}</code>\n\n` +

    `🔎 Найдено новостей: ` +
    `${state.totalFound || 0}\n` +

    `✅ Опубликовано: ` +
    `${state.totalPosted || 0}\n` +

    `⏭ Пропущено: ` +
    `${state.totalSkipped || 0}\n` +

    `❌ Ошибок: ` +
    `${state.totalErrors || 0}\n\n` +

    `📦 В очереди: ` +
    `${queue}\n` +

    `⏱ Лимит: 1 пост / 60 сек\n\n` +

    `🕐 Последняя проверка:\n` +
    `${formatDate(
      state.lastCheck
    )}\n\n` +

    `📤 Последняя публикация:\n` +
    `${formatDate(
      state.lastPost
    )}`
  );
}

async function sendStatsToAdmin(
  callbackQueryId = null
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    if (callbackQueryId) {
      await telegram(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackQueryId,
        }
      );
    }

    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          buildStatsText(),

        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "Stats error:",
      error.message
    );
  }
}

/* =======================================================
   VERSION
======================================================= */

async function sendVersionToAdmin(
  callbackQueryId = null
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  try {
    if (callbackQueryId) {
      await telegram(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackQueryId,
        }
      );
    }

    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          `🧩 <b>ВЕРСИЯ БОТА</b>\n\n` +

          `AI News Bot\n` +

          `Версия: ` +
          `<code>${VERSION}</code>\n\n` +

          `🚀 Запуск:\n` +
          `${formatDate(
            state.startedAt
          )}\n\n` +

          `🟢 Эта версия сейчас ` +
          `запущена на сервере.`,

        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );
  } catch (error) {
    console.error(
      "Version error:",
      error.message
    );
  }
}

/* =======================================================
   STARTUP NOTIFICATION
======================================================= */

async function notifyAdminStartup() {
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
            `🚀 <b>AI NEWS BOT ЗАПУЩЕН</b>\n\n` +

            `🧩 Версия: ` +
            `<code>${VERSION}</code>\n\n` +

            `✅ Новая версия реально запущена.\n\n` +

            `📡 Источников: ` +
            `${FEEDS.length}\n` +

            `⏱ Проверка: ` +
            `${CHECK_INTERVAL_MIN} мин\n` +

            `📤 Публикация: ` +
            `1 пост / 60 сек\n` +

            `🛡 Дубли: ` +
            `${SIMILARITY_THRESHOLD * 100}%\n\n` +

            `Ниже доступно управление ботом.`,

          parse_mode:
            "HTML",

          reply_markup:
            adminKeyboard(),
        }
      );

    adminStatusMessageId =
      result.message_id;
  } catch (error) {
    console.error(
      "Startup notification error:",
      error.message
    );
  }
}

/* =======================================================
   DUPLICATE DETECTION
======================================================= */

function normalizeWords(title) {
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

function jaccardSimilarity(
  wordsA,
  wordsB
) {
  const setA =
    new Set(wordsA);

  const setB =
    new Set(wordsB);

  if (
    setA.size === 0 ||
    setB.size === 0
  ) {
    return 0;
  }

  const intersection =
    [...setA].filter(
      (word) =>
        setB.has(word)
    ).length;

  const union =
    new Set([
      ...setA,
      ...setB,
    ]).size;

  return (
    intersection /
    union
  );
}

function findSimilarPosted(
  title,
  postedList
) {
  const words =
    normalizeWords(title);

  return postedList.find(
    (post) =>
      jaccardSimilarity(
        words,
        normalizeWords(
          post.title
        )
      ) >=
      SIMILARITY_THRESHOLD
  );
}

/* =======================================================
   GROQ
======================================================= */

const EDITOR_PROMPT =
  "Ты редактор новостного Telegram-канала. " +
  "Тебе дают заголовок и текст новости. " +
  "Верни ТОЛЬКО валидный JSON без пояснений, в формате " +
  '{"title":"заголовок на русском языке","summary":"краткий пересказ на русском, 3-5 предложений, только суть, без воды и без вымышленных фактов"}' +
  ". Если оригинал уже на русском — немного отполируй заголовок, смысл не меняй. " +
  "Никогда не придумывай факты.";

async function summarizeAndTranslate(
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

        body:
          JSON.stringify({
            model:
              "openai/gpt-oss-120b",

            messages: [
              {
                role:
                  "system",

                content:
                  EDITOR_PROMPT,
              },

              {
                role:
                  "user",

                content:
                  `Заголовок: ${title}\n\n` +
                  `Текст статьи: ${content}`,
              },
            ],

            temperature: 0.4,

            max_tokens: 500,

            response_format: {
              type:
                "json_object",
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

  const contentText =
    data.choices[0]
      .message
      .content;

  const parsed =
    JSON.parse(
      contentText
    );

  return {
    title:
      parsed.title ||
      title,

    summary:
      parsed.summary ||
      "",
  };
}

/* =======================================================
   MEDIA
======================================================= */

function extractMedia(item) {
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
          item.enclosure.url,

        kind:
          "video",
      };
    }

    if (
      type.startsWith(
        "image"
      )
    ) {
      return {
        url:
          item.enclosure.url,

        kind:
          "photo",
      };
    }
  }

  if (
    item.mediaContent &&
    item.mediaContent.length
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
        url:
          media.url,

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
    item.mediaThumbnail.length
  ) {
    const media =
      item.mediaThumbnail[0]
        .$ || {};

    if (media.url) {
      return {
        url:
          media.url,

        kind:
          "photo",
      };
    }
  }

  const html =
    item.content ||
    item["content:encoded"] ||
    "";

  const match =
    html.match(
      /<img[^>]+src="([^">]+)"/
    );

  if (match) {
    return {
      url:
        match[1],

      kind:
        "photo",
    };
  }

  return null;
}

/* =======================================================
   CHANNEL PUBLICATION
======================================================= */

async function sendToChannel(
  text,
  media
) {
  let method =
    "sendMessage";

  let payload = {
    chat_id:
      CHANNEL_ID,

    text,

    disable_web_page_preview:
      true,
  };

  if (
    media &&
    media.kind ===
      "photo"
  ) {
    method =
      "sendPhoto";

    payload = {
      chat_id:
        CHANNEL_ID,

      photo:
        media.url,

      caption:
        text.slice(
          0,
          1024
        ),
    };
  }

  if (
    media &&
    media.kind ===
      "video"
  ) {
    method =
      "sendVideo";

    payload = {
      chat_id:
        CHANNEL_ID,

      video:
        media.url,

      caption:
        text.slice(
          0,
          1024
        ),
    };
  }

  try {
    return await telegram(
      method,
      payload
    );
  } catch (error) {
    /*
       Если медиа не отправилось,
       пробуем обычным текстом.
    */

    if (media) {
      console.warn(
        "⚠️ Media send failed. Fallback to text:",
        error.message
      );

      return await telegram(
        "sendMessage",
        {
          chat_id:
            CHANNEL_ID,

          text,

          disable_web_page_preview:
            true,
        }
      );
    }

    throw error;
  }
}

/* =======================================================
   QUEUE
======================================================= */

function isInQueue(link) {
  return publicationQueue.some(
    (item) =>
      item.link === link
  );
}

function addToQueue(news) {
  if (
    isInQueue(
      news.link
    )
  ) {
    return false;
  }

  publicationQueue.push(
    news
  );

  console.log(
    `📦 В очередь: ${news.ruTitle}`
  );

  updateAdminStatus()
    .catch(() => {});

  return true;
}

/* =======================================================
   PUBLICATION WORKER
======================================================= */

async function publicationWorker() {
  if (publisherRunning) {
    return;
  }

  if (
    publicationQueue.length === 0
  ) {
    return;
  }

  publisherRunning = true;

  try {
    while (
      publicationQueue.length >
      0
    ) {
      /*
         Проверяем реальное время последней публикации.
      */

      if (lastPublicationTime) {
        const elapsed =
          Date.now() -
          lastPublicationTime;

        const wait =
          POST_INTERVAL_MS -
          elapsed;

        if (wait > 0) {
          setStage(
            "⏳ Ожидание публикации",

            `Следующая публикация через ${Math.ceil(
              wait / 1000
            )} сек.`
          );

          await sleep(wait);
        }
      }

      const news =
        publicationQueue.shift();

      if (!news) {
        continue;
      }

      setStage(
        "📤 Публикация",

        `${news.source}: ${news.ruTitle}`
      );

      try {
        await sendToChannel(
          news.text,
          news.media
        );

        /*
           Сохраняем новость только после
           успешной отправки.
        */

        const posted =
          loadPosted();

        posted.push({
          link:
            news.link,

          title:
            news.originalTitle,

          source:
            news.source,

          publishedAt:
            new Date()
              .toISOString(),
        });

        savePosted(
          posted
        );

        state.totalPosted =
          (state.totalPosted || 0) +
          1;

        state.lastPost =
          new Date()
            .toISOString();

        lastPublicationTime =
          Date.now();

        saveState();

        console.log(
          `✅ Опубликовано: ${news.ruTitle}`
        );
      } catch (error) {
        state.totalErrors =
          (state.totalErrors || 0) +
          1;

        saveState();

        console.error(
          "❌ Publication error:",
          error.message
        );
      }

      updateAdminStatus()
        .catch(() => {});
    }
  } finally {
    publisherRunning =
      false;

    setStage(
      "🟢 Ожидание новых новостей",
      "Очередь пуста"
    );
  }
}

/* =======================================================
   INITIALIZATION
======================================================= */

/*
   Это критически важная функция.

   При первом запуске / restart:
   текущие новости RSS НЕ публикуются.

   Они только добавляются в posted.json.

   Поэтому после перезапуска бот не начинает
   публиковать старый RSS-архив.
*/

async function initializeCurrentNews() {
  setStage(
    "🛡 Первичная синхронизация",

    "Текущие RSS-новости будут запомнены без публикации"
  );

  const posted =
    loadPosted();

  let remembered =
    0;

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
          ITEMS_PER_FEED
        );

      for (
        const item of items
      ) {
        if (
          !item.link
        ) {
          continue;
        }

        const exists =
          posted.some(
            (p) =>
              p.link ===
              item.link
          );

        if (!exists) {
          posted.push({
            link:
              item.link,

            title:
              item.title ||
              "",

            source:
              source.name,

            initializedAt:
              new Date()
                .toISOString(),

            initialized:
              true,
          });

          remembered++;
        }
      }

      state.sourceStats[
        source.name
      ] = {
        status:
          "🟢 Готов",

        found:
          items.length,

        lastCheck:
          new Date()
            .toISOString(),

        error:
          null,
      };
    } catch (error) {
      state.sourceStats[
        source.name
      ] = {
        status:
          "🔴 Ошибка",

        found:
          0,

        lastCheck:
          new Date()
            .toISOString(),

        error:
          error.message,
      };

      console.error(
        `Initialization error ${source.name}:`,
        error.message
      );
    }
  }

  savePosted(
    posted
  );

  state.initialized =
    true;

  state.version =
    VERSION;

  state.lastCheck =
    new Date()
      .toISOString();

  saveState();

  console.log(
    `🛡 Синхронизация завершена. Запомнено: ${remembered}`
  );

  setStage(
    "✅ Синхронизация завершена",

    `Запомнено ${remembered} текущих новостей`
  );
}

/* =======================================================
   CHECK FEEDS
======================================================= */

async function checkFeeds() {
  if (isChecking) {
    console.log(
      "⚠️ Проверка уже выполняется."
    );

    return;
  }

  isChecking =
    true;

  try {
    /*
       Если состояние не инициализировано,
       не публикуем RSS-архив.
    */

    if (!isInitialized) {
      await initializeCurrentNews();

      isInitialized =
        true;

      return;
    }

    setStage(
      "🔎 Поиск новостей",

      `Проверяем ${FEEDS.length} источников`
    );

    const posted =
      loadPosted();

    let foundThisCheck =
      0;

    for (
      const source of FEEDS
    ) {
      setStage(
        "📡 Проверка источника",

        source.name
      );

      try {
        const feed =
          await parser.parseURL(
            source.url
          );

        const items =
          feed.items.slice(
            0,
            ITEMS_PER_FEED
          );

        state.sourceStats[
          source.name
        ] = {
          status:
            "🟢 Работает",

          found:
            items.length,

          lastCheck:
            new Date()
              .toISOString(),

          error:
            null,
        };

        for (
          const item of items
        ) {
          if (
            !item.link
          ) {
            continue;
          }

          /*
             Уже опубликована или запомнена.
          */

          const alreadyKnown =
            posted.some(
              (p) =>
                p.link ===
                item.link
            );

          if (
            alreadyKnown
          ) {
            continue;
          }

          /*
             Дубликат в очереди.
          */

          if (
            isInQueue(
              item.link
            )
          ) {
            continue;
          }

          foundThisCheck++;

          state.totalFound =
            (state.totalFound || 0) +
            1;

          setStage(
            "🔎 Найдена новая новость",

            `${source.name}: ${item.title || "Без заголовка"}`
          );

          /*
             Проверяем похожесть заголовка.
          */

          const similar =
            findSimilarPosted(
              item.title ||
                "",
              posted
            );

          if (similar) {
            console.log(
              `⏭ Дубликат: "${item.title}" ≈ "${similar.title}"`
            );

            /*
               Запоминаем ссылку,
               чтобы больше не проверять её.
            */

            posted.push({
              link:
                item.link,

              title:
                item.title ||
                "",

              source:
                source.name,

              skipped:
                true,

              skippedAt:
                new Date()
                  .toISOString(),
            });

            state.totalSkipped =
              (state.totalSkipped || 0) +
              1;

            continue;
          }

          /*
             ИИ.
          */

          setStage(
            "🧠 Обработка ИИ",

            `${source.name}: ${item.title || ""}`
          );

          try {
            const result =
              await summarizeAndTranslate(
                item.title ||
                  "",

                item.contentSnippet ||
                  item.content ||
                  item.title ||
                  ""
              );

            const text =
              `📰 ${result.title}\n\n` +
              `${result.summary}\n\n` +
              `Источник: ${source.name}`;

            const media =
              extractMedia(
                item
              );

            addToQueue({
              link:
                item.link,

              originalTitle:
                item.title ||
                "",

              ruTitle:
                result.title,

              source:
                source.name,

              text,

              media,
            });

            console.log(
              `📦 Добавлено в очередь: ${result.title}`
            );
          } catch (error) {
            state.totalErrors =
              (state.totalErrors || 0) +
              1;

            console.error(
              `❌ AI error ${source.name}:`,
              error.message
            );
          }
        }
      } catch (error) {
        state.totalErrors =
          (state.totalErrors || 0) +
          1;

        state.sourceStats[
          source.name
        ] = {
          status:
            "🔴 Ошибка",

          found:
            0,

          lastCheck:
            new Date()
              .toISOString(),

          error:
            error.message,
        };

        console.error(
          `❌ RSS error ${source.name}:`,
          error.message
        );
      }
    }

    savePosted(
      posted
    );

    state.lastCheck =
      new Date()
        .toISOString();

    saveState();

    setStage(
      "📦 Новости готовы к публикации",

      `Новых: ${foundThisCheck}. В очереди: ${publicationQueue.length}`
    );

    /*
       Запускаем worker.
       Он сам выдерживает 60 секунд между постами.
    */

    publicationWorker()
      .catch(
        (error) => {
          console.error(
            "Publisher fatal error:",
            error.message
          );
        }
      );
  } catch (error) {
    state.totalErrors =
      (state.totalErrors || 0) +
      1;

    saveState();

    console.error(
      "❌ checkFeeds error:",
      error.message
    );

    setStage(
      "🔴 Ошибка проверки",
      error.message
    );
  } finally {
    isChecking =
      false;

    saveState();

    updateAdminStatus()
      .catch(() => {});
  }
}

/* =======================================================
   ADMIN COMMANDS
======================================================= */

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
    String(
      ADMIN_CHAT_ID
    )
  ) {
    return;
  }

  const text =
    (
      message.text || ""
    ).trim();

  if (!text) {
    return;
  }

  const command =
    text
      .split(/\s+/)[0]
      .toLowerCase();

  if (
    command ===
    "/start"
  ) {
    await sendAdminMenu();
    return;
  }

  if (
    command ===
    "/menu"
  ) {
    await sendAdminMenu();
    return;
  }

  if (
    command ===
    "/status"
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          buildStatusText(),

        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );

    return;
  }

  if (
    command ===
    "/sources"
  ) {
    await sendSourcesToAdmin();
    return;
  }

  if (
    command ===
    "/version"
  ) {
    await sendVersionToAdmin();
    return;
  }

  if (
    command ===
    "/stats"
  ) {
    await sendStatsToAdmin();
    return;
  }

  if (
    command ===
    "/check"
  ) {
    if (isChecking) {
      await telegram(
        "sendMessage",
        {
          chat_id:
            ADMIN_CHAT_ID,

          text:
            "⚠️ Проверка уже выполняется.",
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
          "🔎 Проверка новостей запущена.",
      }
    );

    checkFeeds();

    return;
  }

  if (
    command ===
    "/help"
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          `🤖 <b>AI News Bot</b>\n\n` +

          `/menu — главное меню\n` +
          `/status — текущий этап\n` +
          `/sources — источники\n` +
          `/version — версия\n` +
          `/stats — статистика\n` +
          `/check — проверить сейчас\n` +
          `/help — помощь`,

        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );

    return;
  }
}

/* =======================================================
   CALLBACK BUTTONS
======================================================= */

async function handleCallbackQuery(
  callback
) {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  const message =
    callback.message;

  if (!message) {
    return;
  }

  if (
    String(
      message.chat.id
    ) !==
    String(
      ADMIN_CHAT_ID
    )
  ) {
    return;
  }

  const data =
    callback.data;

  if (
    data ===
    "admin_status"
  ) {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id,
      }
    );

    await telegram(
      "sendMessage",
      {
        chat_id:
          ADMIN_CHAT_ID,

        text:
          buildStatusText(),

        parse_mode:
          "HTML",

        reply_markup:
          adminKeyboard(),
      }
    );

    return;
  }

  if (
    data ===
    "admin_sources"
  ) {
    await sendSourcesToAdmin(
      callback.id
    );

    return;
  }

  if (
    data ===
    "admin_stats"
  ) {
    await sendStatsToAdmin(
      callback.id
    );

    return;
  }

  if (
    data ===
    "admin_version"
  ) {
    await sendVersionToAdmin(
      callback.id
    );

    return;
  }

  if (
    data ===
    "admin_refresh"
  ) {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id,

        text:
          "🔄 Статус обновлён",
      }
    );

    await sendAdminMenu();

    return;
  }

  if (
    data ===
    "admin_check"
  ) {
    if (isChecking) {
      await telegram(
        "answerCallbackQuery",
        {
          callback_query_id:
            callback.id,

          text:
            "⚠️ Проверка уже выполняется",
        }
      );

      return;
    }

    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id:
          callback.id,

        text:
          "🔎 Проверка запущена",
      }
    );

    checkFeeds();

    return;
  }
}

/* =======================================================
   TELEGRAM POLLING
======================================================= */

async function adminPollingLoop() {
  if (!ADMIN_CHAT_ID) {
    return;
  }

  if (
    adminPollingRunning
  ) {
    return;
  }

  adminPollingRunning =
    true;

  console.log(
    "📨 Telegram admin polling запущен"
  );

  /*
     При старте берём только новые update.
     Старые команды из очереди не выполняем.
  */

  try {
    const pending =
      await telegram(
        "getUpdates",
        {
          offset:
            -1,

          limit:
            1,

          timeout:
            1,
        }
      );

    if (
      pending &&
      pending.length
    ) {
      telegramUpdateOffset =
        pending[
          pending.length - 1
        ].update_id;
    }
  } catch (error) {
    console.warn(
      "⚠️ Не удалось очистить старые Telegram updates:",
      error.message
    );
  }

  while (true) {
    try {
      const updates =
        await telegram(
          "getUpdates",
          {
            offset:
              telegramUpdateOffset + 1,

            timeout:
              25,

            allowed_updates: [
              "message",
              "callback_query",
            ],
          }
        );

      if (
        updates &&
        updates.length
      ) {
        for (
          const update of updates
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
            await handleCallbackQuery(
              update.callback_query
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "Telegram polling error:",
        error.message
      );

      await sleep(5000);
    }
  }
}

/* =======================================================
   HTTP ROUTES
======================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      `AI News Bot v${VERSION} is running.`
    );
  }
);

app.get(
  "/status",
  (req, res) => {
    res.json({
      version:
        VERSION,

      checking:
        isChecking,

      stage:
        lastStage,

      details:
        lastStageDetails,

      queue:
        publicationQueue.length,

      totalFound:
        state.totalFound || 0,

      totalPosted:
        state.totalPosted || 0,

      totalSkipped:
        state.totalSkipped || 0,

      totalErrors:
        state.totalErrors || 0,

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
          name:
            source.name,

          url:
            source.url,

          ...(state.sourceStats[
            source.name
          ] || {}),
        })
      )
    );
  }
);

app.get(
  "/run-now",
  async (req, res) => {
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
      "Проверка запущена. Смотри статус в ЛС."
    );
  }
);

/* =======================================================
   SERVER START
======================================================= */

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      "========================================"
    );

    console.log(
      `🤖 AI News Bot v${VERSION}`
    );

    console.log(
      `📡 Источников: ${FEEDS.length}`
    );

    console.log(
      "📤 Лимит: 1 публикация / 60 секунд"
    );

    console.log(
      `⏱ Проверка RSS: каждые ${CHECK_INTERVAL_MIN} минут`
    );

    console.log(
      "========================================"
    );

    /*
       Запуск приложения.
    */

    (async () => {
      try {
        await notifyAdminStartup();

        setStage(
          "🚀 Бот запущен",
          `Версия ${VERSION}`
        );

        /*
           ВАЖНО:
           если state.initialized === false,
           первая проверка только синхронизирует RSS.
        */

        await checkFeeds();

        /*
           Telegram админ-команды.
        */

        adminPollingLoop();

        /*
           Регулярная проверка RSS.
        */

        setInterval(
          () => {
            checkFeeds();
          },
          CHECK_INTERVAL_MIN *
            60 *
            1000
        );
      } catch (error) {
        console.error(
          "❌ Fatal startup error:",
          error
        );

        setStage(
          "🔴 Критическая ошибка",
          error.message
        );
      }
    })();
  }
);
