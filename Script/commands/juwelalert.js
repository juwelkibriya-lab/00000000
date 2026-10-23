/**
 * ╔══════════════════════════════════════════════════════════╗
 *  JUWEL ALERT  —  Session Alert + Bot Start/Stop Notice
 *  Credit : 乛 M𝆠፝֟R ཐི༏ཋྀ JU𝆠፝֟W𝆠፝֟ELꜛཐི༏ཋྀ࿐
 * ╚══════════════════════════════════════════════════════════╝
 *
 *  এই ফাইল একাই চলে (juwelstats.js ছাড়াও কাজ করে)।
 *
 *  কী করে:
 *   ১) বট চালু হলে ADMINBOT-দের মেসেঞ্জার ইনবক্সে "চালু হয়েছে" নোটিশ পাঠায়।
 *   ২) প্রতি ৫ মিনিটে সেশন পরীক্ষা করে; সেশন মরলে Telegram/Discord-এ সতর্কতা পাঠায়।
 *      (মূল অ্যাকাউন্ট লগআউট হলে মেসেঞ্জারে পাঠানো যায় না, তাই বাইরের মাধ্যম লাগে)
 *        env: JUWEL_TG_TOKEN, JUWEL_TG_CHAT   (Telegram)
 *             JUWEL_DISCORD_WEBHOOK            (Discord)
 *   ৩) সেশন ফিরে এলে Telegram/Discord + মেসেঞ্জার অ্যাডমিনদের "আবার অনলাইন" জানায়।
 *   ৪) বটের লগে FATAL / session dead / login failed দেখলে সেটাও হিসেবে ধরে।
 *   ৫) [নতুন] বট বন্ধ হলে (কমান্ড/process.exit, Ctrl+C, SIGTERM, SIGHUP)
 *      Telegram/Discord-এ "STOPPED" নোটিশ পাঠায় — কত দিন/ঘণ্টা/মিনিট/সেকেন্ড চালু ছিল সহ।
 *
 *  কমান্ড:  #juwelalert        (সেশনের অবস্থা দেখায়, শুধু বট-অ্যাডমিন)
 *           #juwelalert test   (টেস্ট সতর্কতা পাঠিয়ে দেখে Telegram/Discord ঠিক আছে কি না)
 *  (নোট: বটে আগে থেকেই `alert` নামে আলাদা কমান্ড আছে, তাই এর নাম juwelalert রাখা হয়েছে)
 */

try { console.log("[JuwelAlert] ফাইল লোড হয়েছে (juwelalert.js)"); } catch (_) {}

const axios = require("axios");

const PROBE_EVERY_MS = Number(process.env.JUWEL_PROBE_MS) || 5 * 60 * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const PROBE_FAILS_BEFORE_ALERT = 2;
const BOOT_NOTICE_DELAY_MS = Number(process.env.JUWEL_BOOT_MS) || 45 * 1000;
const STOP_NOTICE_WAIT_MS = 7000; // বন্ধ হওয়ার আগে নোটিশ পাঠাতে সর্বোচ্চ এত সময় অপেক্ষা

const state = global.__juwelAlert || (global.__juwelAlert = {
  started: false,
  bootAt: Date.now(),
  logHits: [],
  lastLoginIssueAt: 0,
  probeFails: 0,
  lastProbeOk: null,
  lastProbeAt: 0,
  lastAlertAt: 0,
  down: false,
  downSince: 0,
  bootNoticeSent: false
});

/* ───────────── helpers ───────────── */
const dhakaTime = () => {
  try { return new Date().toLocaleString("en-GB", { timeZone: "Asia/Dhaka", hour12: true }); }
  catch (_) { return new Date().toISOString(); }
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + h + "h " + m + "m";
};
const pad2 = (n) => String(n).padStart(2, "0");
// সেকেন্ড থেকে দিন/ঘণ্টা/মিনিট/সেকেন্ড
const uptimeParts = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
};

// ইংরেজি অক্ষর ও সংখ্যা → 𝗔𝗕𝗖𝗗 𝟭𝟮𝟯 (Sans-Serif Bold). বাংলা/ইমোজি অপরিবর্তিত থাকে।
const fx = (str) => String(str).replace(/[A-Za-z0-9]/g, (c) => {
  const n = c.charCodeAt(0);
  if (n >= 65 && n <= 90) return String.fromCodePoint(0x1D5D4 + n - 65);
  if (n >= 97 && n <= 122) return String.fromCodePoint(0x1D5EE + n - 97);
  return String.fromCodePoint(0x1D7EC + n - 48);
});
const CREDIT = "乛 M𝆠፝֟R ཐི༏ཋྀ JU𝆠፝֟W𝆠፝֟ELꜛཐི༏ཋྀ࿐"; // ফন্ট-রূপান্তর হয় না, যেমন আছে তেমন

const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

function log(msg, level) {
  try { require("../../utils/log.js")("[JuwelAlert] " + msg, level || "info"); }
  catch (_) { try { process.stdout.write("[JuwelAlert] " + msg + "\n"); } catch (__) {} }
}

function adminIDs() {
  const c = global.config || {};
  return [...new Set([...(c.ADMINBOT || []), ...(c.DEVELOPER || [])].map(String))];
}

async function sendExternal(text) {
  text = withCredit(text); // ফন্ট + ক্রেডিট সব বার্তায়
  const tgToken = process.env.JUWEL_TG_TOKEN, tgChat = process.env.JUWEL_TG_CHAT;
  const dc = process.env.JUWEL_DISCORD_WEBHOOK;
  let sent = false;
  if (tgToken && tgChat) {
    try {
      await axios.post("https://api.telegram.org/bot" + tgToken + "/sendMessage", { chat_id: tgChat, text }, { timeout: 15000 });
      sent = true;
    } catch (e) { log("Telegram পাঠানো যায়নি: " + (e.message || e), "warn"); }
  }
  if (dc) {
    try { await axios.post(dc, { content: text.slice(0, 1900) }, { timeout: 15000 }); sent = true; }
    catch (e) { log("Discord পাঠানো যায়নি: " + (e.message || e), "warn"); }
  }
  if (!tgToken && !tgChat && !dc) log("JUWEL_TG_TOKEN/JUWEL_TG_CHAT বা JUWEL_DISCORD_WEBHOOK সেট করা নেই — শুধু লগে লেখা হলো।", "warn");
  return sent;
}

async function sendMessengerToAdmins(text) {
  text = withCredit(text); // ফন্ট + ক্রেডিট সব বার্তায়
  const api = global.client && global.client.api;
  if (!api) return;
  for (const id of adminIDs()) {
    try { await new Promise((res) => api.sendMessage(text, id, () => res())); } catch (_) {}
  }
}

/* ───────────── alerts ───────────── */
const HEAD = (title) => "╔══════════════════╗\n   " + title + "\n╚══════════════════╝";
const LINE = "━━━━━━━━━━━━━━━━━━━━";

async function raiseAlert(reason) {
  const now = Date.now();
  if (!state.down) { state.down = true; state.downSince = now; }
  if (now - state.lastAlertAt < ALERT_COOLDOWN_MS) return;
  state.lastAlertAt = now;
  const text =
    HEAD("🚨 JUWEL BOT • ALERT") + "\n\n" +
    "🔴 STATUS ➤ SESSION PROBLEM\n" + LINE + "\n" +
    "📛 কারণ ➤ " + reason + "\n" +
    "🕒 TIME ➤ " + dhakaTime() + "\n" + LINE + "\n" +
    "🛠 করণীয়: নতুন appstate.json (কুকি) বসিয়ে বট রিস্টার্ট দিন।";
  log("সতর্কতা: " + reason, "error");
  await sendExternal(text);
}

async function raiseRecovery() {
  if (!state.down) return;
  const downFor = Date.now() - state.downSince;
  state.down = false; state.downSince = 0; state.probeFails = 0; state.lastAlertAt = 0;
  const text =
    HEAD("✅ JUWEL BOT • BACK ONLINE") + "\n\n" +
    "🟢 STATUS ➤ ONLINE\n" + LINE + "\n" +
    "⏳ অফলাইন ছিল ➤ " + fmtDur(downFor) + "\n" +
    "🕒 TIME ➤ " + dhakaTime();
  log("সেশন ফিরে এসেছে।", "success");
  await sendExternal(text);
  await sendMessengerToAdmins(text);
}

/* ───────────── stop notice (বট বন্ধ হলে) ───────────── */
let stopPromise = null;

function stopText(reason) {
  const up = uptimeParts(process.uptime());
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  let started;
  try { started = startedAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", hour12: true }); }
  catch (_) { started = startedAt.toISOString(); }

  return (
    HEAD("🔴 JUWEL BOT • STOPPED") + "\n\n" +
    "🔴 STATUS ➤ OFFLINE\n" + LINE + "\n" +
    "📛 কারণ ➤ " + reason + "\n" + LINE + "\n" +
    "⏱ চালু ছিল\n" +
    " ┌ 📆 DAYS ➤ " + pad2(up.d) + "\n" +
    " ├ 🕐 HOURS ➤ " + pad2(up.h) + "\n" +
    " ├ ⏰ MINUTES ➤ " + pad2(up.m) + "\n" +
    " └ ⏳ SECONDS ➤ " + pad2(up.s) + "\n" +
    " ✦ " + up.d + "d " + pad2(up.h) + "h " + pad2(up.m) + "m " + pad2(up.s) + "s\n" + LINE + "\n" +
    "📅 STARTED ➤ " + started + "\n" +
    "🕒 STOPPED ➤ " + dhakaTime()
  );
}

// একবারই পাঠায়; একই promise ফেরত দেয় যাতে exit তার জন্য অপেক্ষা করতে পারে
function sendStopNotice(reason) {
  if (stopPromise) return stopPromise;
  log("বট বন্ধ হচ্ছে: " + reason, "warn");
  stopPromise = Promise.race([
    sendExternal(stopText(reason)).catch(() => false),
    new Promise((res) => setTimeout(res, STOP_NOTICE_WAIT_MS))
  ]);
  return stopPromise;
}

function installShutdownHook() {
  if (global.__juwelAlertShutdownHooked) return;
  global.__juwelAlertShutdownHooked = true;

  const origExit = process.exit.bind(process);

  // কমান্ড/কোড থেকে process.exit() ডাকলে — আগে নোটিশ, তারপর বন্ধ
  process.exit = function (code) {
    const c = code === undefined ? 0 : code;
    sendStopNotice("process.exit(" + c + ") — কমান্ড/কোড দিয়ে বন্ধ").then(
      () => origExit(c),
      () => origExit(c)
    );
  };

  // Ctrl+C, systemd/pm2/docker stop, টার্মিনাল বন্ধ
  const names = { SIGINT: "Ctrl+C (SIGINT)", SIGTERM: "stop সিগন্যাল (SIGTERM)", SIGHUP: "টার্মিনাল বন্ধ (SIGHUP)" };
  Object.keys(names).forEach((sig) => {
    try {
      process.on(sig, () => {
        sendStopNotice(names[sig] + " — ম্যানুয়ালি বন্ধ").then(() => origExit(0), () => origExit(0));
      });
    } catch (_) {}
  });
}

/* ───────────── log watcher ───────────── */
const BAD_PATTERNS = [
  /FATAL: Session/i, /Session looks dead/i, /Login failed \[/i,
  /Fresh login failed/i, /re-login required/i, /checkpoint/i, /not logged in/i
];
const GOOD_PATTERNS = [/recovered after \d+ attempt/i, /traffic resumed/i, /session established/i];

function installLogWatcher() {
  if (global.__juwelAlertLogHooked) return;
  global.__juwelAlertLogHooked = true;
  ["log", "warn", "error"].forEach((method) => {
    const orig = console[method];
    console[method] = function () {
      try {
        const line = stripAnsi(Array.prototype.map.call(arguments, (a) => (typeof a === "string" ? a : "")).join(" "));
        if (line && line.length < 2000 && !/JuwelAlert/.test(line)) {
          if (BAD_PATTERNS.some((r) => r.test(line))) {
            state.lastLoginIssueAt = Date.now();
            state.logHits.push({ t: Date.now(), line: line.trim().slice(0, 160) });
            if (state.logHits.length > 20) state.logHits.shift();
          } else if (GOOD_PATTERNS.some((r) => r.test(line))) {
            state.lastLoginIssueAt = 0; state.logHits = []; state.probeFails = 0;
            raiseRecovery();
          }
        }
      } catch (_) {}
      return orig.apply(console, arguments);
    };
  });
}

/* ───────────── active probe ───────────── */
function evaluate(reason) {
  const recent = state.lastLoginIssueAt && (Date.now() - state.lastLoginIssueAt < 15 * 60 * 1000);
  if (state.probeFails >= PROBE_FAILS_BEFORE_ALERT || (state.probeFails >= 1 && recent)) {
    const extra = recent && state.logHits.length ? " | লগ: " + state.logHits[state.logHits.length - 1].line : "";
    raiseAlert(reason + extra);
  }
}

function probe() {
  const api = global.client && global.client.api;
  state.lastProbeAt = Date.now();
  if (!api || typeof api.getCurrentUserID !== "function") {
    state.probeFails++; state.lastProbeOk = false;
    return evaluate("api অবজেক্ট পাওয়া যাচ্ছে না");
  }
  let uid;
  try { uid = api.getCurrentUserID(); } catch (_) {}
  if (!uid) { state.probeFails++; state.lastProbeOk = false; return evaluate("api থেকে UID পাওয়া যাচ্ছে না"); }

  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    state.probeFails++; state.lastProbeOk = false;
    evaluate("ফেসবুক সার্ভার থেকে সাড়া নেই (timeout)");
  }, 25000);
  try {
    api.getUserInfo(uid, (err) => {
      if (done) return; done = true; clearTimeout(timer);
      if (err) {
        state.probeFails++; state.lastProbeOk = false;
        evaluate("সেশন পরীক্ষা ব্যর্থ: " + String((err && (err.error || err.message)) || err).slice(0, 120));
      } else {
        state.probeFails = 0; state.lastProbeOk = true;
        if (state.down) raiseRecovery();
      }
    });
  } catch (e) {
    done = true; clearTimeout(timer);
    state.probeFails++; state.lastProbeOk = false;
    evaluate("পরীক্ষা চালাতে ত্রুটি: " + e.message);
  }
}

/* ───────────── boot ───────────── */
function start() {
  if (state.started) return;
  state.started = true;
  installLogWatcher();
  installShutdownHook();
  const t = setInterval(probe, PROBE_EVERY_MS);
  if (t.unref) t.unref();

  // চালু-নোটিশ: লগইন স্থির হওয়ার পর ADMINBOT-দের ইনবক্সে
  const b = setTimeout(async () => {
    if (state.bootNoticeSent) return;
    state.bootNoticeSent = true;
    const text =
      HEAD("🟢 JUWEL BOT • STARTED") + "\n\n" +
      "🟢 STATUS ➤ ONLINE\n" + LINE + "\n" +
      "🕒 TIME ➤ " + dhakaTime() + "\n" +
      "⚙️ COMMANDS ➤ " + (global.client && global.client.commands ? global.client.commands.size : "?");
    // Telegram/Discord-এও যায় (বন্ধ করতে env: JUWEL_TG_BOOT=off)
    if (String(process.env.JUWEL_TG_BOOT || "").toLowerCase() !== "off") await sendExternal(text);
    await sendMessengerToAdmins(text);
  }, BOOT_NOTICE_DELAY_MS);
  if (b.unref) b.unref();
  log("চালু হয়েছে — সেশন নজরদারি শুরু।", "success");
}

function healthText() {
  const up = uptimeParts(process.uptime());
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  const probeTxt = state.lastProbeOk === null ? "PENDING" : state.lastProbeOk ? "✅ OK" : "❌ FAILED";
  const probeAgo = state.lastProbeAt ? " (" + fmtDur(Date.now() - state.lastProbeAt) + " ago)" : "";
  const tg = process.env.JUWEL_TG_TOKEN && process.env.JUWEL_TG_CHAT ? "ON ✅" : "OFF ❌";
  const dc = process.env.JUWEL_DISCORD_WEBHOOK ? "ON ✅" : "OFF ❌";
  const ram = Math.round(process.memoryUsage().rss / 1048576);
  const cmds = global.client && global.client.commands ? global.client.commands.size : "?";
  let started;
  try { started = startedAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", hour12: true }); }
  catch (_) { started = startedAt.toISOString(); }

  return (
    HEAD("🤖 JUWEL BOT • STATUS") + "\n\n" +
    (state.down ? "🔴 STATUS ➤ PROBLEM" : "🟢 STATUS ➤ ONLINE") + "\n" + LINE + "\n" +
    "⏱ UPTIME\n" +
    " ┌ 📆 DAYS ➤ " + pad2(up.d) + "\n" +
    " ├ 🕐 HOURS ➤ " + pad2(up.h) + "\n" +
    " ├ ⏰ MINUTES ➤ " + pad2(up.m) + "\n" +
    " └ ⏳ SECONDS ➤ " + pad2(up.s) + "\n" +
    " ✦ " + up.d + "d " + pad2(up.h) + "h " + pad2(up.m) + "m " + pad2(up.s) + "s\n" + LINE + "\n" +
    "📅 STARTED ➤ " + started + "\n" +
    "🕒 NOW ➤ " + dhakaTime() + "\n" + LINE + "\n" +
    "🩺 HEALTH CHECK\n" +
    " ┌ RESULT ➤ " + probeTxt + probeAgo + "\n" +
    " ├ FAILS IN ROW ➤ " + state.probeFails + "\n" +
    " └ LOGIN WARNINGS ➤ " + state.logHits.length + "\n" + LINE + "\n" +
    "📡 ALERT CHANNELS\n" +
    " ┌ TELEGRAM ➤ " + tg + "\n" +
    " └ DISCORD ➤ " + dc + "\n" + LINE + "\n" +
    "💾 RAM ➤ " + ram + " MB\n" +
    "⚙️ COMMANDS ➤ " + cmds
  );
}

// কার্ড = ফন্ট-রূপান্তরিত টেক্সট + (রূপান্তরহীন) ক্রেডিট লাইন
const withCredit = (t) => fx(t) + "\n" + LINE + "\n✨ Credit ➤ " + CREDIT;

/* ───────────── command ───────────── */
module.exports.config = {
  name: "juwelalert",
  aliases: ["jalert"],
  version: "1.1.0",
  hasPermssion: 2,
  credits: "乛 M𝆠፝֟R ཐི༏ཋྀ JU𝆠፝֟W𝆠፝֟ELꜛཐི༏ཋྀ࿐",
  description: "সেশন সতর্কতা ও বট চালু/বন্ধ নোটিশ",
  commandCategory: "system",
  usages: "juwelalert [test]",
  cooldowns: 5
};

module.exports.onLoad = function () {
  try { start(); } catch (e) { log("start ত্রুটি: " + e.message, "error"); }
};

// onLoad না চললেও (কিছু লোডারে) প্রথম ইভেন্টেই চালু হয়ে যাবে
module.exports.handleEvent = function () {
  if (!state.started) { try { start(); } catch (_) {} }
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID, messageID } = event;
  if (!state.started) start();
  if ((args[0] || "").toLowerCase() === "test") {
    const ok = await sendExternal(HEAD("🧪 JUWEL ALERT • TEST") + "\n\nএই বার্তা এলে Telegram/Discord সতর্কতা ঠিক আছে।\n🕒 TIME ➤ " + dhakaTime());
    return api.sendMessage(withCredit(ok ? "✅ TEST SENT\nটেস্ট বার্তা পাঠানো হয়েছে — Telegram/Discord চেক করুন।" : "❌ FAILED\nপাঠানো যায়নি। JUWEL_TG_TOKEN ও JUWEL_TG_CHAT সঠিক কি না দেখুন।"), threadID, messageID);
  }
  return api.sendMessage(withCredit(healthText()), threadID, messageID);
};

// ফাইল লোড হওয়ার সাথে সাথেই চালু — onLoad/handleEvent না চললেও নজরদারি ও চালু-নোটিশ কাজ করবে
try { start(); } catch (e) { log("start ত্রুটি: " + e.message, "error"); }
