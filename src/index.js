import { Bot, InlineKeyboard, webhookCallback } from "grammy";

// ecom (31.28.5.203) убран — Cloudflare Workers режет fetch() на голый IP по
// plain HTTP ещё до выхода наружу (подтверждено: запрос не долетает до
// сервера вообще, см. nginx access.log). Вернуть, когда у ecom появится
// собственный домен.
const SITES = ["https://3x3.team", "https://ecom.try.3x3.team", "https://tracker.3x3.team"];

const DISK_WARN_PERCENT = 85;

const FETCH_TIMEOUT_MS = 5000;

// Задержки перед повторной попыткой: секундный сетевой блип (как 23.09 в 00:00
// и 04:00 — запрос не долетал до сервера вообще, см. историю чата) не должен
// считаться падением. Реальное падение переживёт все три попытки.
const RETRY_DELAYS_MS = [300, 800];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Разбирает причину сетевой ошибки на человеческий текст, чтобы в логе и
// алерте сразу было видно ЧТО сломалось: таймаут / DNS / TLS / отказ в
// соединении / сброс — а не просто "нет ответа".
function classifyError(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `таймаут >${FETCH_TIMEOUT_MS}мс`;
  }
  const msg = err?.message ?? String(err);
  const causeMsg = err?.cause?.message ?? err?.cause?.code ?? "";
  const haystack = `${msg} ${causeMsg}`;
  if (/dns|ENOTFOUND|EAI_AGAIN|resolve/i.test(haystack)) return `DNS не резолвится (${msg})`;
  if (/ECONNREFUSED|refused/i.test(haystack)) return `соединение отклонено (${msg})`;
  if (/ECONNRESET|reset/i.test(haystack)) return `соединение сброшено (${msg})`;
  if (/certificate|SSL|TLS/i.test(haystack)) return `TLS-ошибка (${msg})`;
  return causeMsg ? `${err?.name ?? "Error"}: ${msg} (cause: ${causeMsg})` : `${err?.name ?? "Error"}: ${msg}`;
}

async function fetchSiteOnce(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual", // видим первый прыжок как есть, не даём fetch тихо уйти на другой хост
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (uptime-check; 3x3-internal-monitoring)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    return {
      ok: res.status >= 200 && res.status < 300,
      code: location ? `${res.status} -> ${location}` : String(res.status),
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, code: classifyError(err), elapsedMs: Date.now() - started };
  }
}

async function checkOneSite(url) {
  const attempts = [];
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    const attempt = await fetchSiteOnce(url);
    attempts.push(attempt);
    if (attempt.ok) break;
    if (i < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[i]);
  }
  const last = attempts[attempts.length - 1];
  const recovered = last.ok && attempts.length > 1;
  if (!last.ok || recovered) {
    console.log(
      `[check] ${url}`,
      JSON.stringify(attempts.map((a) => ({ ok: a.ok, code: a.code, ms: a.elapsedMs }))),
    );
  }
  return {
    url,
    ok: last.ok,
    code: recovered ? `${last.code} (ожил после ${attempts.length} попыт${attempts.length === 2 ? "ки" : "ок"})` : last.code,
    attempts: attempts.length,
    elapsedMs: last.elapsedMs,
  };
}

async function checkSites() {
  return Promise.all(SITES.map(checkOneSite));
}

async function checkServerHealth() {
  const attempts = [];
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    const started = Date.now();
    try {
      const res = await fetch("https://3x3.team/status.json", {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        attempts.push({ ok: false, reason: `status.json вернул ${res.status}`, elapsedMs });
      } else {
        const data = await res.json();
        const warnings = [];
        if (data.disk_percent >= DISK_WARN_PERCENT) {
          warnings.push(`диск заполнен на ${data.disk_percent}%`);
        }
        if (i > 0) console.log("[health] ожил после ретрая", JSON.stringify(attempts));
        return { ok: warnings.length === 0, warnings, data, elapsedMs, attempts: i + 1 };
      }
    } catch (err) {
      attempts.push({ ok: false, reason: classifyError(err), elapsedMs: Date.now() - started });
    }
    if (i < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[i]);
  }
  console.log("[health] все попытки провалились", JSON.stringify(attempts));
  const last = attempts[attempts.length - 1];
  return { ok: false, reason: last.reason, attempts: attempts.length };
}

// Хранит последние 30 зафиксированных инцидентов в KV, чтобы /history мог
// показать разбор причины сбоя без пересборки контекста через ssh заново.
async function logIncident(env, down, health) {
  const entry = {
    time: new Date().toISOString(),
    down: down.map((r) => ({ url: r.url, code: r.code, attempts: r.attempts })),
    health: health.ok ? null : { reason: health.reason ?? health.warnings?.join(", "), attempts: health.attempts },
  };
  const raw = await env.SUBSCRIBERS.get("history");
  const list = raw ? JSON.parse(raw) : [];
  list.push(entry);
  while (list.length > 30) list.shift();
  await env.SUBSCRIBERS.put("history", JSON.stringify(list));
}

function subscribeKeyboard(enabled) {
  return new InlineKeyboard().text(
    enabled ? "🔕 Отключить уведомления" : "🔔 Включить уведомления",
    "toggle",
  );
}

function buildBot(env) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // По умолчанию — подписан. Отключить можно кнопкой, ничего не нужно вводить руками.
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if ((await env.SUBSCRIBERS.get(chatId)) === null) {
      await env.SUBSCRIBERS.put(chatId, "on");
    }
    const enabled = (await env.SUBSCRIBERS.get(chatId)) !== "off";
    await ctx.reply(
      "Слежу за 3x3.team и рабочей станцией. Раз в 10 минут проверяю тихо, " +
        "пишу только если что-то упало. /history — последние инциденты.\n\nУведомления сейчас: " +
        (enabled ? "включены ✅" : "выключены 🔕"),
      { reply_markup: subscribeKeyboard(enabled) },
    );
  });

  bot.command("status", async (ctx) => {
    const [results, health] = await Promise.all([checkSites(), checkServerHealth()]);
    const lines = results.map((r) => `${r.ok ? "✅" : "⚠️"} ${r.url} — ${r.code}`);
    lines.push(
      health.ok
        ? `✅ сервер — диск ${health.data?.disk_percent ?? "?"}%, память ${health.data?.mem_percent ?? "?"}%`
        : `⚠️ сервер — ${health.reason ?? health.warnings.join(", ")}`,
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("history", async (ctx) => {
    const raw = await env.SUBSCRIBERS.get("history");
    const list = raw ? JSON.parse(raw) : [];
    if (list.length === 0) {
      await ctx.reply("Инцидентов пока не зафиксировано.");
      return;
    }
    const last = list.slice(-10).reverse();
    const lines = last.map((entry) => {
      const parts = [];
      for (const d of entry.down) parts.push(`${d.url} — ${d.code}`);
      if (entry.health) parts.push(`рабочая станция — ${entry.health.reason}`);
      return `🕒 ${entry.time}\n${parts.join("\n")}`;
    });
    await ctx.reply(`Последние ${last.length} инцидент(ов):\n\n${lines.join("\n\n")}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    if (ctx.callbackQuery.data !== "toggle") return;
    const chatId = String(ctx.chat.id);
    const wasOff = (await env.SUBSCRIBERS.get(chatId)) === "off";
    await env.SUBSCRIBERS.put(chatId, wasOff ? "on" : "off");
    const enabled = wasOff;
    await ctx.editMessageReplyMarkup({ reply_markup: subscribeKeyboard(enabled) });
    await ctx.answerCallbackQuery(enabled ? "Уведомления включены" : "Уведомления выключены");
  });

  return bot;
}

export default {
  async fetch(request, env, ctx) {
    const bot = buildBot(env);
    return webhookCallback(bot, "cloudflare-mod")(request, env, ctx);
  },

  // Cron trigger — раз в 10 минут, молча если всё ок, шлёт всем подписанным при падении.
  async scheduled(_event, env, _ctx) {
    const [results, health] = await Promise.all([checkSites(), checkServerHealth()]);
    const down = results.filter((r) => !r.ok);

    // Полный лог каждого прогона (не только падений) — виден в `wrangler tail`.
    console.log(
      "[scheduled]",
      JSON.stringify({
        sites: results.map((r) => ({ url: r.url, ok: r.ok, code: r.code, attempts: r.attempts, ms: r.elapsedMs })),
        health: { ok: health.ok, reason: health.reason, attempts: health.attempts },
      }),
    );

    if (down.length === 0 && health.ok) return;

    await logIncident(env, down, health);

    const parts = [];
    if (down.length > 0) {
      parts.push("⚠️ Проблема с сайтом:\n" + down.map((r) => `${r.url} — ${r.code}`).join("\n"));
    }
    if (!health.ok) {
      parts.push("⚠️ Рабочая станция: " + (health.reason ?? health.warnings.join(", ")));
    }
    const text = parts.join("\n\n");

    const list = await env.SUBSCRIBERS.list();
    for (const key of list.keys) {
      const val = await env.SUBSCRIBERS.get(key.name);
      if (val === "off") continue;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: key.name, text }),
      });
    }
  },
};
