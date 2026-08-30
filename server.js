const express = require("express");
const fetch = require("node-fetch");
const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

const app = express();

const parser = new Parser({
  timeout: 15000,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // например @my_ai_news или -1001234567890
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "30", 10);
const RUN_SECRET = process.env.RUN_SECRET || null;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

// насколько похожими должны быть заголовки, чтобы считать это дублем (0-1, чем выше - тем строже)
const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || "0.5");

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------------- источники новостей (RSS) ----------------
// 👇 ВОТ СЮДА добавляешь источники: ссылка на RSS + название для поста
const FEEDS = [
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", name: "TechCrunch" },
  { url: "https://venturebeat.com/category/ai/feed/", name: "VentureBeat" },
  { url: "https://www.technologyreview.com/topic/artificial-intelligence/feed", name: "MIT Technology Review" },
  { url: "https://www.artificialintelligence-news.com/feed/", name: "AI News" },
  { url: "https://www.mk.ru/rss/news/index.xml", name: "МК" },
  { url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss", name: "РБК" },
  // RTVI не публикует публичную RSS-ссылку явно, это стандартный шаблон - если не сработает,
  // просто удали эту строку, на остальных источниках это никак не скажется
  { url: "https://rtvi.com/feed/", name: "RTVI" },
  // { url: "https://example.com/rss", name: "Example" }
];

// ---------------- хранилище уже опубликованного (для защиты от дублей) ----------------
const POSTED_FILE = path.join(__dirname, "data", "posted.json");
if (!fs.existsSync(path.dirname(POSTED_FILE))) {
  fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });
}
if (!fs.existsSync(POSTED_FILE)) {
  fs.writeFileSync(POSTED_FILE, JSON.stringify([]));
}
function loadPosted() {
  // формат записи: { link, title }
  return JSON.parse(fs.readFileSync(POSTED_FILE, "utf8"));
}
function savePosted(list) {
  // держим последние 300 записей, чтобы файл не рос бесконечно
  fs.writeFileSync(POSTED_FILE, JSON.stringify(list.slice(-300), null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- проверка на похожесть заголовков ----------------
function normalizeWords(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // убираем знаки препинания (юникод-совместимо, работает и с кириллицей)
    .split(/\s+/)
    .filter((w) => w.length > 3); // отсекаем короткие слова/предлоги, они не несут смысла
}

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

function findSimilarPosted(title, postedList) {
  const words = normalizeWords(title);
  return postedList.find((p) => jaccardSimilarity(words, normalizeWords(p.title)) >= SIMILARITY_THRESHOLD);
}

// ---------------- как Groq "редактирует" пост ----------------
// Раз добавили общие новостные сайты (МК, РБК, RTVI) вместе с AI-источниками,
// промпт обновлён под общий новостной канал, а не только про ИИ.
// Если хочешь вернуть фокус только на ИИ - поменяй текст здесь.
const EDITOR_PROMPT =
  "Ты редактор новостного Telegram-канала. " +
  "Кратко перескажи новость на русском языке (3-5 предложений), только суть, без воды, " +
  "без вымышленных фактов и без своих оценок.";

async function summarize(title, content) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      // llama-3.3-70b-versatile Groq отключает - перешли на более умную и поддерживаемую модель
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: EDITOR_PROMPT },
        { role: "user", content: `Заголовок: ${title}\n\nТекст статьи: ${content}` },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
  });
  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error("Groq error: " + JSON.stringify(data));
  }
  return data.choices[0].message.content.trim();
}

// ---------------- поиск картинки/видео в RSS-записи ----------------
function extractMedia(item) {
  if (item.enclosure && item.enclosure.url) {
    const type = item.enclosure.type || "";
    if (type.startsWith("video")) return { url: item.enclosure.url, kind: "video" };
    if (type.startsWith("image")) return { url: item.enclosure.url, kind: "photo" };
  }
  if (item.mediaContent && item.mediaContent.length) {
    const m = item.mediaContent[0].$ || {};
    if (m.url) {
      const type = m.medium || m.type || "";
      return { url: m.url, kind: type.includes("video") ? "video" : "photo" };
    }
  }
  if (item.mediaThumbnail && item.mediaThumbnail.length) {
    const m = item.mediaThumbnail[0].$ || {};
    if (m.url) return { url: m.url, kind: "photo" };
  }
  const html = item.content || item["content:encoded"] || "";
  const match = html.match(/<img[^>]+src="([^">]+)"/);
  if (match) return { url: match[1], kind: "photo" };

  return null;
}

// ---------------- публикация в канал ----------------
async function sendToChannel(text, media) {
  let endpoint = "sendMessage";
  let payload = { chat_id: CHANNEL_ID, text, disable_web_page_preview: true };

  if (media && media.kind === "photo") {
    endpoint = "sendPhoto";
    payload = { chat_id: CHANNEL_ID, photo: media.url, caption: text.slice(0, 1024) };
  } else if (media && media.kind === "video") {
    endpoint = "sendVideo";
    payload = { chat_id: CHANNEL_ID, video: media.url, caption: text.slice(0, 1024) };
  }

  const resp = await fetch(`${API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();

  if (!data.ok && media) {
    console.warn("Media send failed, falling back to text:", data.description);
    return sendToChannel(text, null);
  }
  if (!data.ok) {
    console.error("Telegram send error:", data.description);
  }
  return data;
}

// ---------------- основной цикл проверки ----------------
async function checkFeeds() {
  console.log("Checking feeds...");
  const posted = loadPosted();

  for (const source of FEEDS) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 3)) {
        if (!item.link) continue;

        // 1. точный дубль по ссылке - уже публиковали именно эту статью
        if (posted.some((p) => p.link === item.link)) continue;

        // 2. похожая новость с другим источником/ссылкой (та же история, другими словами)
        const similar = findSimilarPosted(item.title || "", posted);
        if (similar) {
          console.log(`Пропущено как дубль: "${item.title}" похоже на "${similar.title}"`);
          posted.push({ link: item.link, title: item.title || "" });
          savePosted(posted);
          continue;
        }

        try {
          const summary = await summarize(
            item.title || "",
            item.contentSnippet || item.content || item.title || ""
          );
          const text = `📰 ${item.title}\n\n${summary}\n\nИсточник: ${source.name}`;
          const media = extractMedia(item);

          await sendToChannel(text, media);
          posted.push({ link: item.link, title: item.title || "" });
          savePosted(posted);
          console.log("Posted:", item.title, media ? `(с ${media.kind})` : "(без медиа)");
        } catch (e) {
          console.error("Summarize/post error for", item.link, e.message);
        }

        await sleep(3000);
      }
    } catch (e) {
      console.error("Feed fetch error:", source.url, e.message);
    }
  }
}

// ---------------- уведомление о успешном запуске ----------------
async function notifyAdmin() {
  if (!ADMIN_CHAT_ID) {
    console.log("ADMIN_CHAT_ID не задан - пропускаю уведомление о запуске.");
    return;
  }
  const text =
    `✅ Бот подключён и работает\n\n` +
    `Источников новостей: ${FEEDS.length}\n` +
    `Проверка каждые: ${CHECK_INTERVAL_MIN} мин\n` +
    `Защита от дублей: похожесть заголовков >= ${SIMILARITY_THRESHOLD * 100}%\n` +
    `Публикация в: ${CHANNEL_ID}`;
  await fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }),
  });
}

notifyAdmin();
checkFeeds();
setInterval(checkFeeds, CHECK_INTERVAL_MIN * 60 * 1000);

app.get("/run-now", async (req, res) => {
  if (RUN_SECRET && req.query.secret !== RUN_SECRET) {
    return res.status(403).send("forbidden");
  }
  checkFeeds();
  res.send("Проверка запущена, смотри логи и канал через минуту-две.");
});

app.get("/", (req, res) => {
  res.send("AI news bot is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

