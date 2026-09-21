import { Bot, InlineKeyboard, webhookCallback } from "grammy";

// ecom (31.28.5.203) убран — Cloudflare Workers режет fetch() на голый IP по
// plain HTTP ещё до выхода наружу (подтверждено: запрос не долетает до
// сервера вообще, см. nginx access.log). Вернуть, когда у ecom появится
// собственный домен.
const SITES = ["https://3x3.team", "https://ecom.try.3x3.team", "https://tracker.3x3.team"];

const DISK_WARN_PERCENT = 85;

async function checkServerHealth() {
  try {
    const res = await fetch("https://3x3.team/status.json");
    if (!res.ok) return { ok: false, reason: `status.json вернул ${res.status}` };
    const data = await res.json();
    const warnings = [];
    if (data.disk_percent >= DISK_WARN_PERCENT) {
      warnings.push(`диск заполнен на ${data.disk_percent}%`);
    }
    return { ok: warnings.length === 0, warnings, data };
  } catch {
    return { ok: false, reason: "status.json не отвечает" };
  }
}

async function checkSites() {
  const out = [];
  for (const url of SITES) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual", // видим первый прыжок как есть, не даём fetch тихо уйти на другой хост
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (uptime-check; 3x3-internal-monitoring)",
        },
      });
      const isRedirect = res.status >= 300 && res.status < 400;
      const location = isRedirect ? res.headers.get("location") : null;
      out.push({
        url,
        code: location ? `${res.status} -> ${location}` : res.status,
        ok: res.status >= 200 && res.status < 300,
      });
    } catch {
      out.push({ url, code: "нет ответа", ok: false });
    }
  }
  return out;
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
        "пишу только если что-то упало.\n\nУведомления сейчас: " +
        (enabled ? "включены ✅" : "выключены 🔕"),
      { reply_markup: subscribeKeyboard(enabled) },
    );
  });

  bot.command("status", async (ctx) => {
    const results = await checkSites();
    const health = await checkServerHealth();
    const lines = results.map((r) => `${r.ok ? "✅" : "⚠️"} ${r.url} — ${r.code}`);
    lines.push(
      health.ok
        ? `✅ сервер — диск ${health.data?.disk_percent ?? "?"}%, память ${health.data?.mem_percent ?? "?"}%`
        : `⚠️ сервер — ${health.reason ?? health.warnings.join(", ")}`,
    );
    await ctx.reply(lines.join("\n"));
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
    const results = await checkSites();
    const down = results.filter((r) => !r.ok);
    const health = await checkServerHealth();

    if (down.length === 0 && health.ok) return;

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
