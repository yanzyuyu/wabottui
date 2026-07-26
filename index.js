require("dotenv").config();

// 🔇 Global suppression of harmless libsignal decryption errors
const originalConsoleError = console.error;
console.error = function (...args) {
  const str = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  if (
    str.includes("Failed to decrypt message") ||
    str.includes("MessageCounterError") ||
    str.includes("Key used already") ||
    str.includes("Session error") ||
    str.includes("Bad MAC") ||
    str.includes("Closing session")
  ) {
    return;
  }
  originalConsoleError.apply(console, args);
};

const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
  const str = chunk ? chunk.toString() : "";
  if (
    str.includes("Failed to decrypt message") ||
    str.includes("MessageCounterError") ||
    str.includes("Key used already") ||
    str.includes("Session error") ||
    str.includes("Bad MAC") ||
    str.includes("Closing session")
  ) {
    return true;
  }
  return originalStderrWrite.apply(process.stderr, arguments);
};

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  proto,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const fs = require("fs-extra");
const { exec } = require("child_process");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const Tesseract = require("tesseract.js");
const crypto = require("crypto");
const ytdl = require("@distube/ytdl-core");
const tiktok = require("@tobyg74/tiktok-api-dl");
const readline = require("readline");

ffmpeg.setFfmpegPath(ffmpegPath);

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
let PHONE_NUMBER = process.env.PHONE_NUMBER || "";
const DB_PATH = "./db.json";
const startTime = Date.now();

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeJsonSync(DB_PATH, { users: {} });
  }
  return fs.readJsonSync(DB_PATH);
}

function saveDB(db) {
  fs.writeJsonSync(DB_PATH, db, { spaces: 2 });
}

function getUser(db, jid) {
  if (!db.users[jid]) {
    db.users[jid] = {
      sleeping: false,
      sleepStart: 0,
      notes: {},
    };
  }
  if (!db.users[jid].notes) db.users[jid].notes = {};
  return db.users[jid];
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return { h, m, s, text: `${h}j ${m}m ${s}d` };
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function analyzeSleep(ms) {
  const hours = ms / 3600000;
  if (hours < 4)
    return { status: "Parah 💀", note: "Istirahat lu kacau, jangan sok kuat!" };
  if (hours < 6)
    return {
      status: "Kurang ⚠️",
      note: "Bisa jalan, tapi badan lu bakal protes.",
    };
  if (hours < 8)
    return { status: "Cukup 👍", note: "Aman, tidur lu lumayan teratur." };
  return { status: "Ideal ✨", note: "Mantap! Ini baru manusia normal." };
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

function extractText(msg) {
  if (!msg || !msg.message) return "";
  let m = msg.message;

  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  if (m.editedMessage)
    m = m.editedMessage.message?.protocolMessage?.editedMessage;

  if (!m) return "";

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  );
}

async function callGroqAI(messages, model = "llama-3.3-70b-versatile") {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model, messages },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  return res.data.choices[0].message.content;
}

function showSpinner(text, durationMs = 1200) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      process.stdout.write(
        `\r\x1b[36m${frames[i++ % frames.length]}\x1b[0m \x1b[1m${text}\x1b[0m`,
      );
    }, 80);
    setTimeout(() => {
      clearInterval(interval);
      process.stdout.write(
        `\r\x1b[32m✔\x1b[0m \x1b[1m${text} Selesai!\x1b[0m\n`,
      );
      resolve();
    }, durationMs);
  });
}

async function startBot() {
  await showSpinner("Inisialisasi OpenCode TUI Engine...", 1200);

  // 🎨 OpenCode Aesthetic TUI Banner Header
  console.log(`
\x1b[32m\x1b[1m[SYNC] 🔄 Bot Berhasil Di-restart / Live Auto-Sync Aktif!\x1b[0m
\x1b[36m\x1b[1m┌───────────────────────────────────────────────────────────────┐
│ \x1b[35m🤖 BOTWA OPENCODE TUI DASHBOARD v2.0.0\x1b[36m                       │
│ \x1b[32m⚡ Engine : Baileys v6.7 & Groq Llama-3.3-70B AI\x1b[36m                   │
│ \x1b[33m🔄 Sync   : Watching index.js (Session & DB Ignored)\x1b[36m          │
│ \x1b[34m📂 Folder : ${process.cwd().padEnd(48)}\x1b[36m │
└───────────────────────────────────────────────────────────────┘\x1b[0m
`);

  const { state, saveCreds } = await useMultiFileAuthState("session");
  const { version } = await fetchLatestBaileysVersion();

  let usePairingCode = false;

  // 💬 Interactive Authentication Prompt
  if (!state.creds.registered) {
    console.log(`\x1b[1m\x1b[35m[?] Pilih Metode Autentikasi WhatsApp:\x1b[0m`);
    console.log(`  \x1b[32m┌───┐\x1b[0m`);
    console.log(
      `  \x1b[32m│ 1 │\x1b[0m  📲 \x1b[1mScan QR Code\x1b[0m (Default)`,
    );
    console.log(`  \x1b[32m└───┘\x1b[0m`);
    console.log(`  \x1b[33m┌───┐\x1b[0m`);
    console.log(
      `  \x1b[33m│ 2 │\x1b[0m  🔑 \x1b[1mPairing Code\x1b[0m (Input Nomor HP di Console)`,
    );
    console.log(`  \x1b[33m└───┘\x1b[0m\n`);

    const choice = await askQuestion(
      `\x1b[1m\x1b[36m👉 Pilih opsi [1/2] (Default 1): \x1b[0m`,
    );

    if (choice === "2") {
      usePairingCode = true;
      if (!PHONE_NUMBER) {
        PHONE_NUMBER = await askQuestion(
          `\x1b[1m\x1b[33m📱 Masukkan Nomor WhatsApp (Contoh: 6281234567890): \x1b[0m`,
        );
      }
    }
  }

  console.log(
    `\x1b[34m\n⚡ Connecting to WhatsApp Web (v${version.join(".")})...\x1b[0m\n`,
  );

  // 🔇 Filter out harmless libsignal session decryption noise from console
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    const str = chunk ? chunk.toString() : "";
    if (
      str.includes("Failed to decrypt message") ||
      str.includes("MessageCounterError") ||
      str.includes("Session error") ||
      str.includes("Bad MAC") ||
      str.includes("Closing session")
    ) {
      return true;
    }
    return originalStderrWrite.apply(process.stderr, arguments);
  };

  const msgMap = new Map();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    getMessage: async (key) => {
      if (msgMap.has(key.id)) {
        return msgMap.get(key.id);
      }
      return { conversation: "Bot Active" };
    },
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  const botSentMsgIds = new Set();
  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await rawSendMessage(...args);
    if (res?.key?.id) {
      botSentMsgIds.add(res.key.id);
      if (botSentMsgIds.size > 2000) {
        const first = botSentMsgIds.values().next().value;
        botSentMsgIds.delete(first);
      }
    }
    return res;
  };

  sock.ev.on("creds.update", saveCreds);

  // 🔑 Request Pairing Code if selected
  if (usePairingCode && PHONE_NUMBER && !sock.authState.creds.registered) {
    const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, "");
    console.log(
      `\x1b[33m⏳ Meminta Pairing Code untuk nomor: +${cleanNumber}...\x1b[0m`,
    );
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(cleanNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(`
\x1b[32m\x1b[1m┌───────────────────────────────────────────────────────────────┐
│ 🔑 WHATSAPP PAIRING CODE :  \x1b[33m\x1b[1m${code.padEnd(33)}\x1b[32m│
│ 📱 Tautkan di WA: Perangkat Tertaut -> Tautkan dgn No HP      │
└───────────────────────────────────────────────────────────────┘\x1b[0m
`);
      } catch (err) {
        console.error(
          "\x1b[31m❌ Gagal meminta Pairing Code:\x1b[0m",
          err.message,
        );
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      console.log("\x1b[36m\x1b[1m📲 Scan QR Code WhatsApp berikut:\x1b[0m\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      const botName =
        sock.user?.name || sock.user?.verifiedName || "WhatsApp User";
      const botJid = sock.user?.id
        ? sock.user.id.split(":")[0] + "@s.whatsapp.net"
        : "Unknown JID";

      console.log(`
\x1b[32m\x1b[1m┌───────────────────────────────────────────────────────────────┐
│ ✅ CONNECTED TO WHATSAPP ACCOUNT                             │
│ 👤 Nama Account : \x1b[33m${botName.padEnd(44)}\x1b[32m│
│ 📱 Nomor / JID  : \x1b[36m${botJid.padEnd(44)}\x1b[32m│
└───────────────────────────────────────────────────────────────┘\x1b[0m
`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `\x1b[31m⚠️ Koneksi Terputus (${statusCode || "reconnect"}). Reconnecting in 3s...\x1b[0m`,
      );
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      } else {
        console.log(
          "\x1b[31m🔴 Session Logout. Hapus folder 'session' dan restart bot.\x1b[0m",
        );
      }
    }
  });

  async function resolveTikTokUrl(url) {
    const res = await axios.get(url, { maxRedirects: 5, validateStatus: null });
    return res.request.res.responseUrl || url;
  }

  async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
  }

  async function sendInteractiveMenu(sock, jid, masterMenuText, botSentMsgIds) {
    const res = await sock.sendMessage(jid, { text: masterMenuText });
    if (res?.key?.id) botSentMsgIds.add(res.key.id);
    return res;
  }

  const processedMsgIds = new Set();

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        if (!msg || !msg.message) continue;

        if (msg.key && msg.key.id) {
          if (processedMsgIds.has(msg.key.id)) continue;
          processedMsgIds.add(msg.key.id);
          if (processedMsgIds.size > 5000) {
            const firstKey = processedMsgIds.values().next().value;
            processedMsgIds.delete(firstKey);
          }
        }

        if (msg.key && msg.key.id && botSentMsgIds.has(msg.key.id)) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        let msgSec = 0;
        if (msg.messageTimestamp) {
          if (typeof msg.messageTimestamp === "number")
            msgSec = msg.messageTimestamp;
          else if (
            typeof msg.messageTimestamp === "object" &&
            msg.messageTimestamp.low
          )
            msgSec = msg.messageTimestamp.low;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (msgSec > 0 && nowSec - msgSec > 120) continue;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith("@g.us");
        const pushName = msg.pushName || "Pengirim WA";
        const senderNum = sender.split("@")[0];

        const text = extractText(msg).trim();
        if (!text) continue;

        // 📊 OpenCode Realtime Incoming Message TUI Log
        const timestamp = new Date().toLocaleTimeString("id-ID");
        console.log(
          `\x1b[35m[${timestamp}]\x1b[0m \x1b[33m📩 PESAN MASUK\x1b[0m │ \x1b[36mDari:\x1b[0m \x1b[1m${pushName}\x1b[0m (\x1b[34m${senderNum}\x1b[0m) │ \x1b[32mIsi:\x1b[0m "${text.slice(0, 60)}"`,
        );

        let command = "";
        let args = "";

        if (text.startsWith(".")) {
          command = text.split(" ")[0].toLowerCase();
          args = text.split(" ").slice(1).join(" ");
        } else if (
          text.toLowerCase() === "menu" ||
          text.toLowerCase() === "help"
        ) {
          command = "." + text.toLowerCase();
        } else {
          continue;
        }

        const db = loadDB();
        const user = getUser(db, sender);
        const now = Date.now();

        // ==========================================
        // 📜 INTERACTIVE CATEGORY MENU SYSTEM (200+ COMMANDS)
        // ==========================================
        if (command === ".menu" || command === ".help") {
          const subCat = args.trim().toLowerCase();
          const uptime = formatDuration(now - startTime).text;
          const memoryUsage = (
            process.memoryUsage().heapUsed /
            1024 /
            1024
          ).toFixed(2);

          if (subCat === "1" || subCat === "ai") {
            return sock.sendMessage(sender, {
              text: `
🧠 *[1] AI & CREATIVE SUITE (20+ FITUR)*
────────────────────────
1️⃣ *.ai <tanya>* - AI Joni (Gen-Z / Santai)
2️⃣ *.draw <prompt>* - AI Image Generator HD
3️⃣ *.cowo <teks>* - Roleplay Pacar Cowo
4️⃣ *.cewe <teks>* - Roleplay Pacar Cewe
5️⃣ *.codeai <soal>* - Asisten Koding (JS/Py/HTML)
6️⃣ *.tr <lang> <teks>* - Penerjemah AI
7️⃣ *.summary <teks>* - Ringkasan Teks Panjang AI
8️⃣ *.grammar <teks>* - Koreksi Tata Bahasa AI
9️⃣ *.brainstorm <ide>* - Curah Ide Kreatif AI
🔟 *.interview <posisi>* - Simulasi Interview Kerja
11. *.coverletter <posisi>* - Generator Surat Lamaran
12. *.puisi <topik>* - Pembuat Puisi AI
13. *.pantun <topik>* - Pembuat Pantun AI
14. *.cerpen <tema>* - Pembuat Cerita Pendek AI
15. *.resepai <bahan>* - Generator Resep Masakan
16. *.fitness <tujuan>* - Rencana Olahraga & Diet AI
17. *.startup <ide>* - Generator Plan Startup AI
18. *.slogan <produk>* - Pembuat Slogan Bisnis
19. *.hoaxcheck <berita>* - Analisis Potensi Hoaks AI

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "2" || subCat === "pentest" || subCat === "sec") {
            return sock.sendMessage(sender, {
              text: `
🛡️ *[2] PENTEST & SECURITY UTILS (15+ FITUR)*
────────────────────────
1️⃣ *.headers <url>* - Audit HTTP Security Headers
2️⃣ *.dns <domain>* - DNS Record Lookup (A, MX, TXT)
3️⃣ *.secai <topik>* - Konsultasi Cyber Security
4️⃣ *.jwt <token>* - Decode JWT Header & Payload
5️⃣ *.hash <algo> <teks>* - Crypto Hash (md5, sha1, sha256, sha512)
6️⃣ *.b64enc <teks>* - Base64 Encoder
7️⃣ *.b64dec <string>* - Base64 Decoder
8️⃣ *.hexenc <teks>* - Hexadecimal Encoder
9️⃣ *.hexdec <hex>* - Hexadecimal Decoder
🔟 *.binaryenc <teks>* - Binary Encoder (0101)
11. *.binarydec <binary>* - Binary Decoder
12. *.rot13 <teks>* - ROT13 Cipher
13. *.morse <teks>* - Text to Morse Code
14. *.unmorse <code>* - Morse Code to Text
15. *.macinfo <mac>* - MAC Address Vendor Lookup
16. *.useragent* - Random User-Agent Generator

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "3" || subCat === "downloader" || subCat === "dl") {
            return sock.sendMessage(sender, {
              text: `
📥 *[3] DOWNLOADER SUITE (15+ FITUR)*
────────────────────────
1️⃣ *.tt <url>* - TikTok Video No Watermark
2️⃣ *.ta <url>* - TikTok Audio MP3
3️⃣ *.ytmp3 <url>* - YouTube Audio MP3
4️⃣ *.ytmp4 <url>* - YouTube Video MP4
5️⃣ *.ig <url>* - Instagram Reels & Foto
6️⃣ *.fb <url>* - Facebook Video HD/SD
7️⃣ *.pin <query>* - Pinterest Image Download
8️⃣ *.capcut <url>* - CapCut Template Video

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "4" || subCat === "dev" || subCat === "tools") {
            return sock.sendMessage(sender, {
              text: `
🛠️ *[4] DEVELOPER & SYS UTILS (20+ FITUR)*
────────────────────────
1️⃣ *.ipinfo <ip>* - Lookup IP Geolocation & ISP
2️⃣ *.shorturl <url>* - Shortlink Generator (TinyURL)
3️⃣ *.uuid* - Generate Random v4 UUID
4️⃣ *.password <panjang>* - Secure Password Generator
5️⃣ *.calc <ekspresi>* - Kalkulator Matematika
6️⃣ *.jsonformat <json>* - JSON Formatter & Validator
7️⃣ *.unix* - Unix Timestamp & ISO Date
8️⃣ *.slug <teks>* - Text to URL Slug
9️⃣ *.qr <teks>* - Generator Gambar QR Code
🔟 *.color <hex>* - Preview Warna HEX Code
11. *.fancy <teks>* - Generator Font Estetik (𝓕𝓪𝓷𝓬𝔂 / 𝔽𝕒𝕟𝕔𝕪)
12. *.lorem <jumlah>* - Lorem Ipsum Text Generator
13. *.myip* - Tampilkan IP Publik Bot

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "5" || subCat === "finance" || subCat === "uang") {
            return sock.sendMessage(sender, {
              text: `
📊 *[5] FINANCE & COMMERCE SUITE (15+ FITUR)*
────────────────────────
1️⃣ *.kurs <jum> <from> <to>* - Konversi Mata Uang Dunia
2️⃣ *.crypto <coin>* - Harga Crypto Realtime (BTC, ETH, SOL, DOGE)
3️⃣ *.diskon <harga> <persen>* - Hitung Potongan Diskon
4️⃣ *.pajak <harga> <persen>* - Hitung Pajak & Total Bayar
5]. *.bunga <modal> <bunga%> <bulan>* - Hitung Bunga & Cicilan
6️⃣ *.splitbill <total> <orang>* - Hitung Pembagian Tagihan

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "6" || subCat === "api" || subCat === "info") {
            return sock.sendMessage(sender, {
              text: `
🌐 *[6] API & INFORMATION SUITE (25+ FITUR)*
────────────────────────
1️⃣ *.cuaca <kota>* - Informasi Cuaca Realtime
2️⃣ *.wiki <topik>* - Ringkasan Wikipedia
3️⃣ *.lirik <lagu>* - Lirik Lagu Lengkap
4️⃣ *.anime <judul>* - Info & Sinopsis Anime
5️⃣ *.kbbi <kata>* - Definisi Kata KBBI
6️⃣ *.zodiak <zodiak>* - Ramalan Zodiak Harian
7️⃣ *.quote* - Kata-kata Mutiara / Bijak
8️⃣ *.jadwalsholat <kota>* - Jadwal Sholat Harian
9️⃣ *.gempa* - Info Gempa Bumi BMKG Terkini
🔟 *.fakta* - Fakta Unik Dunia / Sains

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "7" || subCat === "media" || subCat === "sticker") {
            return sock.sendMessage(sender, {
              text: `
🎨 *[7] MEDIA & STICKER EFFECTS (20+ FITUR)*
────────────────────────
1️⃣ *.s / .sticker* - Buat Stiker (Reply Gambar/Video)
2️⃣ *.toimg* - Ubah Stiker Diam ke Gambar JPG
3️⃣ *.hd / .remini* - Tingkatkan Kualitas Foto (Up-scaler)
4️⃣ *.circle / .round* - Potong Foto Jadi Lingkaran
5️⃣ *.grayscale / .bw* - Efek Hitam Putih Foto
6️⃣ *.blur* - Efek Buram Foto
7️⃣ *.invert* - Efek Invert Warna Foto
8️⃣ *.flip* - Flip Horizontal Foto
9️⃣ *.flop* - Flip Vertikal Foto
🔟 *.rotate <derajat>* - Putar Foto (90/180/270)
11. *.tomp3* - Ekstrak Audio MP3 dari Video
12. *.toaudio / .toptt* - Ubah Audio ke Voice Note
13. *.scan* - OCR Tesseract (Ekstrak Teks Foto)

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "8" || subCat === "fun" || subCat === "game") {
            return sock.sendMessage(sender, {
              text: `
🎮 *[8] GAMES & FUN SUITE (35+ FITUR)*
────────────────────────
1️⃣ *.suit <batu/gunting/kertas>* - Bermain Suit vs Bot
2️⃣ *.rate <nama/hal>* - Rating Acak 0 - 100%
3️⃣ *.cekbucin <nama>* - Kalkulator % Bucin
4️⃣ *.cekgay <nama>* - Kalkulator % Gay Fun
5️⃣ *.cekganteng <nama>* - Kalkulator % Ganteng
6️⃣ *.cekcantik <nama>* - Kalkulator % Cantik
7️⃣ *.dadu* - Lempar Dadu (1-6)
8️⃣ *.kerang <pertanyaan>* - Kerang Ajaib SpongeBob
9️⃣ *.truth* - Pertanyaan Tantangan Kejujuran
🔟 *.dare* - Pertanyaan Tantangan Aksi
11. *.8ball <pertanyaan>* - Magic 8-Ball Oracle
12. *.coinflip* - Lempar Koin (Gambar/Angka)
13. *.apakah <pertanyaan>* - Jawaban Ya/Tidak/Mungkin
14. *.bisakah <pertanyaan>* - Jawaban Bisa/Tidak Bisa
15. *.kapankah <pertanyaan>* - Jawaban Estimasi Waktu

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          if (subCat === "9" || subCat === "group" || subCat === "notes") {
            return sock.sendMessage(sender, {
              text: `
👥 *[9] GROUP & PRODUCTIVITY (20+ FITUR)*
────────────────────────
1️⃣ *.tagall <pesan>* - Mention Seluruh Anggota Grup
2️⃣ *.hidetag <pesan>* - Mention Tersembunyi
3️⃣ *.tidur / .bangun* - Sleep Duration Tracker
4️⃣ *.note* - Lihat Catatan Pribadi
5️⃣ *.addnote <nama>|<isi>* - Tambah Catatan Pribadi
6️⃣ *.delnote <nama>* - Hapus Catatan Pribadi
7️⃣ *.clearnotes* - Hapus Semua Catatan Pribadi
8️⃣ *.ping / .runtime* - Cek Latency & Uptime Bot
9️⃣ *.stats* - Statistik Sistem Bot & Penggunaan Memori

💡 *Ketik .menu untuk kembali ke menu utama.*
`.trim(),
            });
          }

          // Master Menu Utama
          const masterMenu = `
┌───────────────────────────────────────────────────┐
│ 🤖 *BOTWA OPENCODE DASHBOARD (200+ FITUR)*         │
├───────────────────────────────────────────────────┤
│ ⏱️ Uptime  : ${uptime.padEnd(36)} │
│ 💾 RAM     : ${(memoryUsage + " MB").padEnd(36)} │
│ 🔑 Auth    : ${(usePairingCode ? "Pairing Code" : "QR Code").padEnd(36)} │
└───────────────────────────────────────────────────┘

📌 *PILIH KATEGORI PERINTAH* (Ketik / Tap Perintah):

 1️⃣  \` .menu 1 \`  │ 🧠 *AI & Creative Suite* (20+ Fitur)
 2️⃣  \` .menu 2 \`  │ 🛡️ *Pentest & Security* (15+ Fitur)
 3️⃣  \` .menu 3 \`  │ 📥 *Downloader Suite* (TT/YT/IG/FB)
 4️⃣  \` .menu 4 \`  │ 🛠️ *Developer & Sys Tools* (IP/Short)
 5️⃣  \` .menu 5 \`  │ 📊 *Finance & Commerce* (Crypto/Kurs)
 6️⃣  \` .menu 6 \`  │ 🌐 *API & Information* (Cuaca/Gempa)
 7️⃣  \` .menu 7 \`  │ 🎨 *Media & Sticker* (Circle/HD/BW)
 8️⃣  \` .menu 8 \`  │ 🎮 *Games & Fun Suite* (Suit/Truth)
 9️⃣  \` .menu 9 \`  │ 👥 *Group & Notes Productivity*

─────────────────────────────────────────────────────
💡 *Tips*: Ketik \`.menu 1\` atau \`.menu ai\` untuk membuka daftar fitur kategori!
`;

          return sendInteractiveMenu(
            sock,
            sender,
            masterMenu.trim(),
            botSentMsgIds,
          );
        }

        if (command === ".ping" || command === ".runtime") {
          const latency = Date.now() - now;
          const uptime = formatDuration(now - startTime).text;
          return sock.sendMessage(sender, {
            text: `🏓 *Pong!*\n⚡ Latency: *${latency} ms*\n⏳ Uptime: *${uptime}*`,
          });
        }

        if (command === ".stats") {
          const uptime = formatDuration(now - startTime).text;
          const mem = process.memoryUsage();
          const statsText = `
📊 *BOT SYSTEM STATISTICS*
────────────────
⏱️ Uptime  : ${uptime}
💾 Heap Used : ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB
💾 Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB
💾 RSS       : ${(mem.rss / 1024 / 1024).toFixed(2)} MB
💻 Platform  : ${process.platform} (${process.arch})
🟢 Node.js   : ${process.version}
`;
          return sock.sendMessage(sender, { text: statsText.trim() });
        }

        // ==========================================
        // 📊 FINANCE & COMMERCE SUITE (.crypto, .diskon, .pajak, .bunga, .splitbill)
        // ==========================================
        if (command === ".crypto") {
          const coin = args.trim().toLowerCase() || "bitcoin";
          await sock.sendMessage(sender, {
            text: `🪙 Mengambil harga crypto ${coin.toUpperCase()}...`,
          });

          try {
            const coinMap = {
              btc: "bitcoin",
              eth: "ethereum",
              sol: "solana",
              doge: "dogecoin",
            };
            const targetCoin = coinMap[coin] || coin;
            const res = await axios.get(
              `https://api.coingecko.com/api/v3/simple/price?ids=${targetCoin}&vs_currencies=usd,idr`,
            );
            if (!res.data[targetCoin])
              return sock.sendMessage(sender, {
                text: `Koin '${coin}' tidak ditemukan.`,
              });

            const usd = res.data[targetCoin].usd.toLocaleString("en-US");
            const idr = res.data[targetCoin].idr.toLocaleString("id-ID");

            return sock.sendMessage(sender, {
              text: `🪙 *HARGA CRYPTO REALTIME*\n📌 Koin: *${targetCoin.toUpperCase()}*\n────────────────\n💵 USD : *$${usd}*\n🇮🇩 IDR : *Rp ${idr}*`,
            });
          } catch (e) {
            return sock.sendMessage(sender, {
              text: "Gagal mengambil harga crypto.",
            });
          }
        }

        if (command === ".diskon") {
          const parts = args.split(" ");
          if (parts.length < 2)
            return sock.sendMessage(sender, {
              text: "Contoh: *.diskon 150000 20*",
            });
          const harga = parseFloat(parts[0]);
          const persen = parseFloat(parts[1]);

          if (isNaN(harga) || isNaN(persen))
            return sock.sendMessage(sender, { text: "Angka tidak valid." });

          const potongan = (harga * persen) / 100;
          const total = harga - potongan;

          return sock.sendMessage(sender, {
            text: `🏷️ *KALKULATOR DISKON*\n💰 Harga Awal: Rp ${harga.toLocaleString("id-ID")}\n📉 Diskon (${persen}%): Rp ${potongan.toLocaleString("id-ID")}\n💵 *Total Bayar: Rp ${total.toLocaleString("id-ID")}*`,
          });
        }

        if (command === ".pajak") {
          const parts = args.split(" ");
          if (parts.length < 2)
            return sock.sendMessage(sender, {
              text: "Contoh: *.pajak 500000 11*",
            });
          const harga = parseFloat(parts[0]);
          const persen = parseFloat(parts[1]);

          if (isNaN(harga) || isNaN(persen))
            return sock.sendMessage(sender, { text: "Angka tidak valid." });

          const nominalPajak = (harga * persen) / 100;
          const total = harga + nominalPajak;

          return sock.sendMessage(sender, {
            text: `📊 *KALKULATOR PAJAK*\n💰 Harga Awal: Rp ${harga.toLocaleString("id-ID")}\n🏛️ Pajak (${persen}%): Rp ${nominalPajak.toLocaleString("id-ID")}\n💵 *Total Bayar: Rp ${total.toLocaleString("id-ID")}*`,
          });
        }

        if (command === ".splitbill") {
          const parts = args.split(" ");
          if (parts.length < 2)
            return sock.sendMessage(sender, {
              text: "Contoh: *.splitbill 250000 4*",
            });
          const total = parseFloat(parts[0]);
          const orang = parseInt(parts[1]);

          if (isNaN(total) || isNaN(orang) || orang <= 0)
            return sock.sendMessage(sender, { text: "Angka tidak valid." });

          const perOrang = Math.ceil(total / orang);
          return sock.sendMessage(sender, {
            text: `🧾 *SPLIT BILL CALCULATOR*\n💵 Total Tagihan: Rp ${total.toLocaleString("id-ID")}\n👥 Jumlah Orang: ${orang} orang\n👉 *Bayar per Orang: Rp ${perOrang.toLocaleString("id-ID")}*`,
          });
        }

        // ==========================================
        // 🛠️ DEVELOPER & SYS UTILS (.ipinfo, .shorturl, .uuid, .password, .calc, .qr, .hexenc, .morse)
        // ==========================================
        if (command === ".qr") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.qr https://google.com*",
            });
          await sock.sendMessage(sender, { text: "🔳 Membuat QR Code..." });

          try {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(args)}`;
            const res = await axios.get(qrUrl, { responseType: "arraybuffer" });
            await sock.sendMessage(sender, {
              image: Buffer.from(res.data),
              caption: `🔳 *QR Code Generator*\n📌 Data: "${args}"`,
            });
          } catch (e) {
            await sock.sendMessage(sender, { text: "Gagal membuat QR Code." });
          }
        }

        if (command === ".hexenc") {
          if (!args)
            return sock.sendMessage(sender, { text: "Contoh: *.hexenc halo*" });
          const hex = Buffer.from(args).toString("hex");
          return sock.sendMessage(sender, {
            text: `🔢 *HEX ENCODER*\n📌 Input: ${args}\n🔑 Hex: \`${hex}\``,
          });
        }

        if (command === ".hexdec") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.hexdec 68616c6f*",
            });
          try {
            const str = Buffer.from(args.trim(), "hex").toString("utf-8");
            return sock.sendMessage(sender, {
              text: `🔢 *HEX DECODER*\n📌 Hex: ${args}\n🔑 Result: \`${str}\``,
            });
          } catch (e) {
            return sock.sendMessage(sender, {
              text: "Format Hex tidak valid.",
            });
          }
        }

        if (command === ".morse") {
          if (!args)
            return sock.sendMessage(sender, { text: "Contoh: *.morse SOS*" });
          const morseMap = {
            A: ".-",
            B: "-...",
            C: "-.-.",
            D: "-..",
            E: ".",
            F: "..-.",
            G: "--.",
            H: "....",
            I: "..",
            J: ".---",
            K: "-.-",
            L: ".-..",
            M: "--",
            N: "-.",
            O: "---",
            P: ".--.",
            Q: "--.-",
            R: ".-.",
            S: "...",
            T: "-",
            U: "..-",
            V: "...-",
            W: ".--",
            X: "-..-",
            Y: "-.--",
            Z: "--..",
            1: ".----",
            2: "..---",
            3: "...--",
            4: "....-",
            5: ".....",
            6: "-....",
            7: "--...",
            8: "---..",
            9: "----.",
            0: "-----",
            " ": "/",
          };
          const code = args
            .toUpperCase()
            .split("")
            .map((c) => morseMap[c] || c)
            .join(" ");
          return sock.sendMessage(sender, {
            text: `📻 *MORSE CODE GENERATOR*\n📌 Input: ${args}\n🔑 Morse: \`${code}\``,
          });
        }

        if (command === ".fancy") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.fancy Halo Dunia*",
            });
          const fancyText = `
✨ *FANCY TEXT GENERATOR*
📌 Input: ${args}
────────────────
1️⃣ 𝓕𝓪𝓷𝓬𝔂: ${args}
2️⃣ 𝔽𝕒𝕟𝕔𝕪: ${args}
3️⃣ ғᴀɴᴄʏ: ${args.toUpperCase()}
`;
          return sock.sendMessage(sender, { text: fancyText.trim() });
        }

        if (command === ".ipinfo") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ipinfo 8.8.8.8*",
            });
          await sock.sendMessage(sender, {
            text: "🔍 Lookup IP Address Geolocation...",
          });

          try {
            const res = await axios.get(
              `http://ip-api.com/json/${encodeURIComponent(args.trim())}`,
            );
            if (res.data.status !== "success")
              return sock.sendMessage(sender, {
                text: "Gagal menemukan informasi IP.",
              });

            const ipText = `
📍 *IP GEOLOCATION LOOKUP*
📌 IP Target : *${res.data.query}*
────────────────
🌐 Negara : ${res.data.country} (${res.data.countryCode})
🏙️ Kota   : ${res.data.city}, ${res.data.regionName}
🏢 ISP    : ${res.data.isp}
🏢 Org    : ${res.data.org || "N/A"}
⏰ Timezone: ${res.data.timezone}
📍 Lat/Lon: ${res.data.lat}, ${res.data.lon}
`;
            await sock.sendMessage(sender, { text: ipText.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil data IP Geolocation.",
            });
          }
        }

        if (command === ".shorturl" || command === ".short") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.shorturl https://google.com*",
            });
          let url = args.trim();
          if (!url.startsWith("http")) url = "https://" + url;

          try {
            const res = await axios.get(
              `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
            );
            await sock.sendMessage(sender, {
              text: `🔗 *SHORTLINK GENERATOR*\n📌 Original: ${url}\n⚡ Shortlink: ${res.data}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal membuat shortlink.",
            });
          }
        }

        if (command === ".uuid" || command === ".guid") {
          const generatedUuid = crypto.randomUUID();
          return sock.sendMessage(sender, {
            text: `🔑 *RANDOM UUID v4*:\n\`${generatedUuid}\``,
          });
        }

        if (command === ".password" || command === ".pass") {
          const len = parseInt(args) || 16;
          const chars =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=";
          let pass = "";
          for (let i = 0; i < Math.min(len, 64); i++) {
            pass += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          return sock.sendMessage(sender, {
            text: `🔐 *SECURE PASSWORD GENERATOR* (Length: ${pass.length})\n\`${pass}\``,
          });
        }

        if (command === ".calc") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.calc 12 * (45 + 10)*",
            });
          try {
            const sanitized = args.replace(/[^0-9+\-*/().]/g, "");
            const result = Function(`'use strict'; return (${sanitized})`)();
            return sock.sendMessage(sender, {
              text: `🧮 *KALKULATOR*\n📌 Ekspresi: ${sanitized}\n💡 Hasil: *${result}*`,
            });
          } catch (e) {
            return sock.sendMessage(sender, {
              text: "Ekspresi matematika tidak valid.",
            });
          }
        }

        if (command === ".jsonformat") {
          if (!args)
            return sock.sendMessage(sender, {
              text: 'Contoh: *.jsonformat {"nama":"royyan"}*',
            });
          try {
            const parsed = JSON.parse(args);
            return sock.sendMessage(sender, {
              text: `📦 *FORMATTED JSON*:\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``,
            });
          } catch (e) {
            return sock.sendMessage(sender, {
              text: "Format JSON string tidak valid.",
            });
          }
        }

        if (command === ".unix") {
          const unixTs = Math.floor(Date.now() / 1000);
          const isoDate = new Date().toISOString();
          return sock.sendMessage(sender, {
            text: `⏱️ *TIMESTAMP INFO*\n📌 Unix Timestamp: *${unixTs}*\n📅 ISO Date: *${isoDate}*`,
          });
        }

        // ==========================================
        // 🌐 BMKG GEMPA & INFORMATION SUITE (.gempa, .fakta)
        // ==========================================
        if (command === ".gempa") {
          await sock.sendMessage(sender, {
            text: "🌐 Mengambil data gempa BMKG...",
          });

          try {
            const res = await axios.get(
              "https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json",
            );
            const g = res.data.Infogempa.gempa;

            const gempaText = `
🌋 *INFO GEMPA TERKINI (BMKG)*
────────────────
📅 Tanggal  : *${g.Tanggal}* (${g.Jam})
💥 Magnitudo: *${g.Magnitude}*
📏 Kedalaman: *${g.Kedalaman}*
📍 Lokasi   : *${g.Wilayah}*
🗺️ Koordinat: ${g.Coordinates}
⚠️ Potensi  : *${g.Potensi}*
`;
            await sock.sendMessage(sender, { text: gempaText.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil data BMKG Gempa.",
            });
          }
        }

        if (command === ".fakta") {
          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Berikan 1 fakta unik sains/dunia yang sangat menarik dan jarang diketahui orang dalam Bahasa Indonesia.",
              },
              { role: "user", content: "Berikan fakta unik sains." },
            ]);
            await sock.sendMessage(sender, {
              text: `💡 *FAKTA UNIK DUNIA*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil fakta unik.",
            });
          }
        }

        // ==========================================
        // 🎨 MEDIA EFFECTS (.circle, .grayscale, .blur, .invert, .flip, .tomp3, .toaudio)
        // ==========================================
        if (command === ".flip" || command === ".flop") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply foto dengan *.flip* atau *.flop*",
            });

          try {
            const buffer = await downloadMedia(imgMsg, "image");
            const outputPath = `./tmp_flip_${Date.now()}.png`;

            const img = sharp(buffer);
            if (command === ".flip") await img.flip().toFile(outputPath);
            else await img.flop().toFile(outputPath);

            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: `🔄 Hasil ${command}`,
            });
            fs.unlinkSync(outputPath);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memproses flip foto.",
            });
          }
        }

        if (command === ".circle" || command === ".round") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply foto dengan *.circle*",
            });

          try {
            await sock.sendMessage(sender, {
              text: "🎨 Memotong foto menjadi bentuk lingkaran...",
            });
            const buffer = await downloadMedia(imgMsg, "image");
            const outputPath = `./tmp_circle_${Date.now()}.png`;

            const circleSvg = Buffer.from(
              '<svg width="512" height="512"><circle cx="256" cy="256" r="256"/></svg>',
            );
            await sharp(buffer)
              .resize(512, 512)
              .composite([{ input: circleSvg, blend: "dest-in" }])
              .png()
              .toFile(outputPath);

            const sticker = new Sticker(fs.readFileSync(outputPath), {
              pack: "BotWA Circle",
              author: "Royyan Bot",
            });
            await sock.sendMessage(sender, {
              sticker: await sticker.toBuffer(),
            });
            fs.unlinkSync(outputPath);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal membuat foto circle.",
            });
          }
        }

        if (command === ".grayscale" || command === ".bw") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply foto dengan *.grayscale*",
            });

          try {
            const buffer = await downloadMedia(imgMsg, "image");
            const outputPath = `./tmp_bw_${Date.now()}.png`;

            await sharp(buffer).grayscale().toFile(outputPath);
            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: "🖤 Hasil Efek Hitam Putih",
            });
            fs.unlinkSync(outputPath);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal menerapkan efek Hitam Putih.",
            });
          }
        }

        if (command === ".blur") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply foto dengan *.blur*",
            });

          try {
            const buffer = await downloadMedia(imgMsg, "image");
            const outputPath = `./tmp_blur_${Date.now()}.png`;

            await sharp(buffer).blur(10).toFile(outputPath);
            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: "🌫️ Hasil Efek Blur",
            });
            fs.unlinkSync(outputPath);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal menerapkan efek Blur.",
            });
          }
        }

        if (command === ".invert") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply foto dengan *.invert*",
            });

          try {
            const buffer = await downloadMedia(imgMsg, "image");
            const outputPath = `./tmp_invert_${Date.now()}.png`;

            await sharp(buffer).negate().toFile(outputPath);
            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: "🔄 Hasil Efek Invert Warna",
            });
            fs.unlinkSync(outputPath);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal menerapkan efek Invert.",
            });
          }
        }

        if (command === ".tomp3") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted || !quoted.videoMessage)
            return sock.sendMessage(sender, {
              text: "Reply video dengan *.tomp3*",
            });

          try {
            await sock.sendMessage(sender, {
              text: "🎵 Ekstrak audio MP3 dari video...",
            });
            const buffer = await downloadMedia(quoted.videoMessage, "video");
            const tmpInput = `./tmp_${Date.now()}.mp4`;
            const tmpOutput = `./tmp_${Date.now()}.mp3`;

            fs.writeFileSync(tmpInput, buffer);
            await new Promise((resolve, reject) => {
              ffmpeg(tmpInput)
                .audioBitrate(128)
                .toFormat("mp3")
                .save(tmpOutput)
                .on("end", resolve)
                .on("error", reject);
            });

            await sock.sendMessage(sender, {
              audio: fs.readFileSync(tmpOutput),
              mimetype: "audio/mpeg",
            });
            fs.unlinkSync(tmpInput);
            fs.unlinkSync(tmpOutput);
          } catch (e) {
            await sock.sendMessage(sender, { text: "Gagal ekstrak audio." });
          }
        }

        if (command === ".toaudio" || command === ".toptt") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted || (!quoted.audioMessage && !quoted.videoMessage))
            return sock.sendMessage(sender, {
              text: "Reply audio/video dengan *.toaudio*",
            });

          try {
            const type = quoted.audioMessage ? "audio" : "video";
            const buffer = await downloadMedia(
              quoted.audioMessage || quoted.videoMessage,
              type,
            );
            const tmpInput = `./tmp_${Date.now()}.${type === "audio" ? "mp3" : "mp4"}`;
            const tmpOutput = `./tmp_${Date.now()}.opus`;

            fs.writeFileSync(tmpInput, buffer);
            await new Promise((resolve, reject) => {
              ffmpeg(tmpInput)
                .toFormat("opus")
                .save(tmpOutput)
                .on("end", resolve)
                .on("error", reject);
            });

            await sock.sendMessage(sender, {
              audio: fs.readFileSync(tmpOutput),
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            });
            fs.unlinkSync(tmpInput);
            fs.unlinkSync(tmpOutput);
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengkonversi ke Voice Note.",
            });
          }
        }

        // ==========================================
        // 🎮 GAMES & FUN (.suit, .rate, .cekbucin, .truth, .dare, .8ball, .coinflip)
        // ==========================================
        if (command === ".truth") {
          const truths = [
            "Apa rahasia terbesar yang belum pernah kamu ceritakan ke siapapun?",
            "Siapa orang yang pernah kamu taksir secara diam-diam di grup ini?",
            "Apa hal paling memalukan yang pernah kamu alami tahun ini?",
            "Kapan terakhir kali kamu menangis dan karena apa?",
          ];
          const res = truths[Math.floor(Math.random() * truths.length)];
          return sock.sendMessage(sender, {
            text: `📜 *TRUTH CHALLENGE*\n📌 Pertanyaan: "${res}"`,
          });
        }

        if (command === ".dare") {
          const dares = [
            "Kirim VN bernyanyi lagu favoritmu selama 15 detik ke obrolan ini!",
            "Ganti foto profil WA kamu jadi foto lucumu selama 1 jam!",
            "Kirimkan kata 'Aku kangen kamu' ke kontak ke-3 di daftar obrolanmu!",
            "Ketik ucapan maaf ke teman terdekatmu tanpa alasan!",
          ];
          const res = dares[Math.floor(Math.random() * dares.length)];
          return sock.sendMessage(sender, {
            text: `🔥 *DARE CHALLENGE*\n📌 Tantangan: "${res}"`,
          });
        }

        if (command === ".8ball") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Tanyakan sesuatu ke Magic 8-Ball!",
            });
          const responses = [
            "Pasti!",
            "Sangat mungkin.",
            "Tentu saja.",
            "Tanya lagi nanti.",
            "Jangan berharap banyak.",
            "Tidak mungkin.",
          ];
          const res = responses[Math.floor(Math.random() * responses.length)];
          return sock.sendMessage(sender, {
            text: `🎱 *MAGIC 8-BALL*\n❓ Q: ${args}\n🔮 A: "${res}"`,
          });
        }

        if (command === ".coinflip") {
          const res = Math.random() < 0.5 ? "GAMBAR 🪙" : "ANGKA 🪙";
          return sock.sendMessage(sender, {
            text: `🪙 *COIN FLIP RESULT*: *${res}*`,
          });
        }

        if (command === ".apakah") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.apakah aku ganteng?*",
            });
          const ans = [
            "Ya, tentu saja!",
            "Tidak sama sekali.",
            "Mungkin iya, mungkin tidak.",
            "Tergantung takdir.",
          ];
          return sock.sendMessage(sender, {
            text: `❓ *APAKAH*: "${args}"\n💡 *Jawaban*: ${ans[Math.floor(Math.random() * ans.length)]}`,
          });
        }

        if (command === ".suit") {
          const choice = args.toLowerCase();
          const choices = ["batu", "gunting", "kertas"];

          if (!choices.includes(choice))
            return sock.sendMessage(sender, {
              text: "Pilih salah satu: *.suit batu*, *.suit gunting*, atau *.suit kertas*",
            });

          const botChoice = choices[Math.floor(Math.random() * choices.length)];
          let result = "";

          if (choice === botChoice) result = "SERI! 🤝";
          else if (
            (choice === "batu" && botChoice === "gunting") ||
            (choice === "gunting" && botChoice === "kertas") ||
            (choice === "kertas" && botChoice === "batu")
          ) {
            result = "KAMU MENANG! 🎉";
          } else {
            result = "BOT MENANG! 😜";
          }

          const suitText = `
🎮 *PERMAINAN SUIT*
────────────────
🧑 Kamu : *${choice.toUpperCase()}*
🤖 Bot  : *${botChoice.toUpperCase()}*
────────────────
🏆 Hasil: *${result}*
`;
          return sock.sendMessage(sender, { text: suitText.trim() });
        }

        if (command === ".rate") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.rate ketampanan lu*",
            });
          const rate = Math.floor(Math.random() * 101);
          return sock.sendMessage(sender, {
            text: `📊 *RATING GENERATOR*\n📌 *${args}*\n💡 Skor: *${rate} / 100%*`,
          });
        }

        if (command === ".cekbucin") {
          const name = args || pushName;
          const rate = Math.floor(Math.random() * 101);
          return sock.sendMessage(sender, {
            text: `❤️ *KALKULATOR BUCIN*\n👤 Nama: *${name}*\n💘 Tingkat Bucin: *${rate}%*`,
          });
        }

        // ==========================================
        // 👥 NOTES SYSTEM (.note, .addnote, .delnote, .clearnotes)
        // ==========================================
        if (command === ".note") {
          const notes = user.notes;
          const keys = Object.keys(notes);

          if (keys.length === 0)
            return sock.sendMessage(sender, {
              text: "Anda belum memiliki catatan. Tambahkan dengan *.addnote judul|isi*",
            });

          let list = `📝 *DAFTAR CATATAN PRIBADI*\n────────────────\n`;
          for (let k of keys) {
            list += `📌 *${k}*: ${notes[k]}\n`;
          }
          return sock.sendMessage(sender, { text: list.trim() });
        }

        if (command === ".addnote") {
          const parts = args.split("|");
          if (parts.length < 2)
            return sock.sendMessage(sender, {
              text: "Contoh: *.addnote password_wifi|12345678*",
            });

          const title = parts[0].trim();
          const content = parts[1].trim();

          user.notes[title] = content;
          saveDB(db);

          return sock.sendMessage(sender, {
            text: `✅ Catatan *'${title}'* berhasil disimpan!`,
          });
        }

        if (command === ".delnote") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.delnote password_wifi*",
            });

          const title = args.trim();
          if (!user.notes[title])
            return sock.sendMessage(sender, {
              text: `Catatan *'${title}'* tidak ditemukan.`,
            });

          delete user.notes[title];
          saveDB(db);

          return sock.sendMessage(sender, {
            text: `🗑️ Catatan *'${title}'* berhasil dihapus!`,
          });
        }

        if (command === ".clearnotes") {
          user.notes = {};
          saveDB(db);
          return sock.sendMessage(sender, {
            text: "🗑️ Semua catatan pribadi berhasil dibersihkan!",
          });
        }

        if (command === ".jadwalsholat") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.jadwalsholat Jakarta*",
            });
          await sock.sendMessage(sender, {
            text: "🕌 Mengambil jadwal sholat...",
          });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah asisten pengingat sholat. Berikan jadwal sholat 5 waktu (Subuh, Dzuhur, Ashar, Maghrib, Isya) hari ini untuk kota yang diminta secara rapi.",
              },
              {
                role: "user",
                content: `Berikan jadwal sholat hari ini untuk kota: ${args}`,
              },
            ]);
            await sock.sendMessage(sender, {
              text: `🕌 *JADWAL SHOLAT (${args.toUpperCase()})*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil jadwal sholat.",
            });
          }
        }

        // ==========================================
        // 🛡️ PENTEST & SECURITY UTILS
        // ==========================================
        if (command === ".secai") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.secai jelaskan mitigasi Broken Access Control*",
            });
          await sock.sendMessage(sender, {
            text: "🛡️ Mengonsultasikan pakar Cyber Security...",
          });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah Senior Cyber Security Specialist & Web Pentester. Berikan penjelasan teknis yang mendalam, profesional, dan berikan panduan mitigasi keamanan yang aman dan berstandar OWASP.",
              },
              { role: "user", content: args },
            ]);
            await sock.sendMessage(sender, {
              text: `🛡️ *CYBER SECURITY CONSULTANT*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memproses konsultasi keamanan.",
            });
          }
        }

        if (command === ".headers") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.headers https://example.com*",
            });
          let target = args.trim();
          if (!target.startsWith("http")) target = "https://" + target;

          await sock.sendMessage(sender, {
            text: "🔍 Memeriksa HTTP Security Headers...",
          });

          try {
            const res = await axios.get(target, {
              maxRedirects: 3,
              validateStatus: () => true,
            });
            const headers = res.headers;

            const secHeaders = {
              "strict-transport-security": headers["strict-transport-security"]
                ? "✅ Ada"
                : "❌ Tidak Ada",
              "content-security-policy": headers["content-security-policy"]
                ? "✅ Ada"
                : "❌ Tidak Ada",
              "x-frame-options": headers["x-frame-options"]
                ? "✅ Ada"
                : "❌ Tidak Ada",
              "x-content-type-options": headers["x-content-type-options"]
                ? "✅ Ada"
                : "❌ Tidak Ada",
              "referrer-policy": headers["referrer-policy"]
                ? "✅ Ada"
                : "❌ Tidak Ada",
              server: headers["server"] || "Hidden",
            };

            const auditResult = `
🛡️ *HTTP SECURITY HEADERS AUDIT*
📌 Target: ${target}
HTTP Status: *${res.status} ${res.statusText}*
────────────────
🔒 *HSTS* : ${secHeaders["strict-transport-security"]}
🛡️ *CSP*  : ${secHeaders["content-security-policy"]}
🖼️ *X-Frame-Options* : ${secHeaders["x-frame-options"]}
📦 *X-Content-Type*  : ${secHeaders["x-content-type-options"]}
🔗 *Referrer-Policy* : ${secHeaders["referrer-policy"]}
🖥️ *Server Header*   : ${secHeaders["server"]}
`;
            await sock.sendMessage(sender, { text: auditResult.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memeriksa HTTP Headers target.",
            });
          }
        }

        if (command === ".dns") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.dns google.com*",
            });
          const domain = args
            .trim()
            .replace(/^https?:\/\//, "")
            .split("/")[0];
          await sock.sendMessage(sender, {
            text: "🌐 Resolving DNS records...",
          });

          try {
            const dnsPromises = require("dns").promises;
            const [aRecords, mxRecords, txtRecords] = await Promise.allSettled([
              dnsPromises.resolve(domain, "A"),
              dnsPromises.resolveMx(domain),
              dnsPromises.resolveTxt(domain),
            ]);

            const aList =
              aRecords.status === "fulfilled"
                ? aRecords.value.join(", ")
                : "None";
            const mxList =
              mxRecords.status === "fulfilled"
                ? mxRecords.value.map((m) => m.exchange).join(", ")
                : "None";
            const txtList =
              txtRecords.status === "fulfilled"
                ? txtRecords.value
                    .map((t) => t.join(" "))
                    .slice(0, 3)
                    .join("\n")
                : "None";

            const dnsText = `
🌐 *DNS LOOKUP RESULT*
📌 Target: *${domain}*
────────────────
📍 *A Records*  : ${aList}
✉️ *MX Records* : ${mxList}
📝 *TXT Records*: 
${txtList}
`;
            await sock.sendMessage(sender, { text: dnsText.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil data DNS.",
            });
          }
        }

        if (command === ".hash") {
          const algo = args.split(" ")[0].toLowerCase();
          const payload = args.split(" ").slice(1).join(" ");

          if (!algo || !payload) {
            return sock.sendMessage(sender, {
              text: "Contoh: *.hash sha256 teks rahasia* (Algo: md5, sha1, sha256, sha512)",
            });
          }

          try {
            const hash = crypto.createHash(algo).update(payload).digest("hex");
            await sock.sendMessage(sender, {
              text: `🔐 *HASH GENERATOR (${algo.toUpperCase()})*\n📌 Input: ${payload}\n🔑 Output: \`${hash}\``,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Algoritma hash tidak valid. Gunakan: md5, sha1, sha256, atau sha512.",
            });
          }
        }

        if (command === ".b64enc") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.b64enc halo dunia*",
            });
          const encoded = Buffer.from(args).toString("base64");
          return sock.sendMessage(sender, {
            text: `🔤 *BASE64 ENCODE*\n📌 Input: ${args}\n🔑 Result: \`${encoded}\``,
          });
        }

        if (command === ".b64dec") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.b64dec aGFsbyBkdW5pYQ==*",
            });
          try {
            const decoded = Buffer.from(args, "base64").toString("utf-8");
            return sock.sendMessage(sender, {
              text: `🔤 *BASE64 DECODE*\n📌 Input: ${args}\n🔑 Result: \`${decoded}\``,
            });
          } catch (e) {
            return sock.sendMessage(sender, { text: "Gagal decode Base64." });
          }
        }

        if (command === ".jwt") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.jwt <jwt_token>*",
            });
          try {
            const parts = args.trim().split(".");
            if (parts.length !== 3)
              return sock.sendMessage(sender, {
                text: "Format JWT token tidak valid (harus ada 3 bagian dipisah titik).",
              });

            const header = JSON.parse(
              Buffer.from(parts[0], "base64").toString("utf-8"),
            );
            const payload = JSON.parse(
              Buffer.from(parts[1], "base64").toString("utf-8"),
            );

            const jwtText = `
🔑 *JWT DECODER*
────────────────
📋 *HEADER*:
\`\`\`json
${JSON.stringify(header, null, 2)}
\`\`\`

📦 *PAYLOAD*:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
`;
            await sock.sendMessage(sender, { text: jwtText.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mendecode JWT token.",
            });
          }
        }

        // ==========================================
        // 🧠 AI & IMAGE CREATOR (IMPROVED)
        // ==========================================
        if (command === ".draw" || command === ".imgai") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.draw pemandangan kota cyberpunk 8k*",
            });
          await sock.sendMessage(sender, {
            text: "🎨 Menggambar ilustrasi AI...",
          });

          try {
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(args)}?width=1024&height=1024&nologo=true`;
            const res = await axios.get(imageUrl, {
              headers: { "User-Agent": "Mozilla/5.0" },
              responseType: "arraybuffer",
            });
            await sock.sendMessage(sender, {
              image: Buffer.from(res.data),
              caption: `🎨 *AI Image Generator*\n📌 Prompt: "${args}"`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal membuat gambar AI.",
            });
          }
        }

        if (command === ".ai") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Ketik pertanyaannya jir. Contoh: *.ai kenapa langit biru?*",
            });
          await sock.sendMessage(sender, { text: "🤔 Mikir bentar..." });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content: `Nama lu Joni. Lu AI santai, rada Gen-Z, rada nyeleneh, jujur, dan ga kaku. Jawab langsung tanpa muter-muter. Bahasa gaul ga usah terlalu cringe. Jawab singkat tapi jelas!`,
              },
              { role: "user", content: args },
            ]);
            await sock.sendMessage(sender, { text: reply });
          } catch (e) {
            console.error(e.response?.data || e.message);
            await sock.sendMessage(sender, {
              text: "❌ AI Groq Error. Cek API Key atau koneksi.",
            });
          }
        }

        if (command === ".cowo") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.cowo lagi apa sayang?*",
            });
          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah cowok pacar ideal, cool, tsundere tapi sebenernya perhatian banget. Bahasa kamu santai kayak lagi chatting sama pacar sendiri.",
              },
              { role: "user", content: args },
            ]);
            await sock.sendMessage(sender, { text: reply });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memproses roleplay cowo.",
            });
          }
        }

        if (command === ".cewe") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.cewe kangen nih*",
            });
          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah cewek pacar imut, manja, ramah, dan perhatian banget. Sering pake kata-kata manis atau ekspresi lucu.",
              },
              { role: "user", content: args },
            ]);
            await sock.sendMessage(sender, { text: reply });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memproses roleplay cewe.",
            });
          }
        }

        if (command === ".codeai") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.codeai buatkan fungsi async fetch data di JS*",
            });
          await sock.sendMessage(sender, { text: "💻 Menggenerasi kode..." });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah Senior Software Engineer. Berikan jawaban kode yang sangat bersih, efisien, lengkap, dan berikan penjelasan singkat.",
              },
              { role: "user", content: args },
            ]);
            await sock.sendMessage(sender, { text: reply });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal menggenerasi kode.",
            });
          }
        }

        if (command === ".tr" || command === ".translate") {
          const lang = args.split(" ")[0];
          const targetText = args.split(" ").slice(1).join(" ");

          if (!lang || !targetText) {
            return sock.sendMessage(sender, {
              text: "Contoh: *.tr en Selamat pagi dunia*",
            });
          }

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content: `Terjemahkan teks berikut ke bahasa target '${lang}'. Hanya berikan hasil terjemahannya tanpa penjelasan tambahan.`,
              },
              { role: "user", content: targetText },
            ]);
            await sock.sendMessage(sender, {
              text: `🌐 *Terjemahan (${lang})*:\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal menerjemahkan teks.",
            });
          }
        }

        // ==========================================
        // 📥 DOWNLOADER SUITE (TikTok, YouTube, IG, FB, Pinterest, CapCut)
        // ==========================================
        if (command === ".tt" || command === ".tiktok") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.tt https://vt.tiktok.com/xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "⏳ Mengunduh video TikTok...",
          });

          try {
            const url = await resolveTikTokUrl(args);
            const res = await tiktok.Downloader(url, { version: "v1" });

            if (!res || res.status !== "success" || !res.result) {
              return sock.sendMessage(sender, {
                text: "Gagal mengambil data dari TikTok.",
              });
            }

            const data = res.result;

            if (data.type === "video" && data.video) {
              const videoUrl = data.video.playAddr?.[0];
              if (!videoUrl)
                return sock.sendMessage(sender, {
                  text: "URL video tidak ditemukan.",
                });

              const v = await axios.get(videoUrl, {
                responseType: "arraybuffer",
              });
              return sock.sendMessage(sender, {
                video: Buffer.from(v.data),
                mimetype: "video/mp4",
                caption: `🎵 *TikTok Video*\n📌 *Judul*: ${data.desc || "No Description"}\n👤 *Author*: ${data.author?.nickname || "TikTok User"}`,
              });
            }

            if (data.type === "image" && Array.isArray(data.images)) {
              for (const img of data.images) {
                const i = await axios.get(img, { responseType: "arraybuffer" });
                await sock.sendMessage(sender, { image: Buffer.from(i.data) });
              }
              return;
            }

            sock.sendMessage(sender, { text: "Tipe konten tidak didukung." });
          } catch (e) {
            console.error(e);
            sock.sendMessage(sender, { text: "Error saat mengunduh TikTok." });
          }
        }

        if (command === ".ta" || command === ".tiktokaudio") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ta https://vt.tiktok.com/xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "🎵 Mengambil audio TikTok...",
          });

          try {
            const res = await tiktok.Downloader(args, { version: "v1" });
            const audioUrl = res?.result?.music?.playUrl;
            if (!audioUrl)
              return sock.sendMessage(sender, {
                text: "Audio tidak ditemukan.",
              });

            const audioRes = await axios.get(audioUrl, {
              responseType: "arraybuffer",
            });
            const tmpInput = `./tmp_${Date.now()}.mp4`;
            const tmpOutput = `./tmp_${Date.now()}.mp3`;

            fs.writeFileSync(tmpInput, Buffer.from(audioRes.data));

            await new Promise((resolve, reject) => {
              ffmpeg(tmpInput)
                .audioBitrate(128)
                .toFormat("mp3")
                .save(tmpOutput)
                .on("end", resolve)
                .on("error", reject);
            });

            await sock.sendMessage(sender, {
              audio: fs.readFileSync(tmpOutput),
              mimetype: "audio/mpeg",
              fileName: "tiktok.mp3",
            });

            fs.unlinkSync(tmpInput);
            fs.unlinkSync(tmpOutput);
          } catch (e) {
            console.error(e);
            sock.sendMessage(sender, { text: "Gagal mengambil audio." });
          }
        }

        if (command === ".ytmp3" || command === ".yta") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ytmp3 https://www.youtube.com/watch?v=xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "🎵 Mengunduh & mengkonversi MP3 YouTube...",
          });

          try {
            const info = await ytdl.getBasicInfo(args);
            const title = info.videoDetails.title;
            const tmpOutput = `./tmp_${Date.now()}.mp3`;

            const stream = ytdl(args, {
              filter: "audioonly",
              quality: "highestaudio",
            });
            await new Promise((resolve, reject) => {
              ffmpeg(stream)
                .audioBitrate(128)
                .toFormat("mp3")
                .save(tmpOutput)
                .on("end", resolve)
                .on("error", reject);
            });

            await sock.sendMessage(sender, {
              audio: fs.readFileSync(tmpOutput),
              mimetype: "audio/mpeg",
              fileName: `${title}.mp3`,
              caption: `🎵 *YouTube Audio*: ${title}`,
            });

            fs.unlinkSync(tmpOutput);
          } catch (e) {
            console.error(e);
            await sock.sendMessage(sender, {
              text: "Gagal mengunduh audio YouTube.",
            });
          }
        }

        if (command === ".ytmp4" || command === ".ytv") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ytmp4 https://www.youtube.com/watch?v=xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "📹 Mengunduh video YouTube MP4...",
          });

          try {
            const info = await ytdl.getBasicInfo(args);
            const title = info.videoDetails.title;
            const tmpOutput = `./tmp_${Date.now()}.mp4`;

            const stream = ytdl(args, {
              filter: "videoandaudio",
              quality: "highestvideo",
            });
            const fileStream = fs.createWriteStream(tmpOutput);
            stream.pipe(fileStream);

            await new Promise((resolve, reject) => {
              fileStream.on("finish", resolve);
              fileStream.on("error", reject);
            });

            await sock.sendMessage(sender, {
              video: fs.readFileSync(tmpOutput),
              mimetype: "video/mp4",
              caption: `📹 *YouTube Video*: ${title}`,
            });

            fs.unlinkSync(tmpOutput);
          } catch (e) {
            console.error(e);
            await sock.sendMessage(sender, {
              text: "Gagal mengunduh video YouTube.",
            });
          }
        }

        if (command === ".ig" || command === ".instagram") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ig https://www.instagram.com/reel/xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "📸 Mengunduh konten Instagram...",
          });

          try {
            const res = await axios
              .get(
                `https://api.lolhuman.xyz/api/instagram?apikey=free&url=${encodeURIComponent(args)}`,
              )
              .catch(() => null);
            if (res && res.data && res.data.result) {
              const media = res.data.result;
              if (Array.isArray(media)) {
                for (let item of media) {
                  const file = await axios.get(item, {
                    responseType: "arraybuffer",
                  });
                  await sock.sendMessage(sender, {
                    video: Buffer.from(file.data),
                    mimetype: "video/mp4",
                    caption: "📸 Instagram Media",
                  });
                }
                return;
              }
            }
            await sock.sendMessage(sender, {
              text: "Gagal mengunduh Instagram. Pastikan akun tidak diprivate dan URL valid.",
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal memproses link Instagram.",
            });
          }
        }

        if (command === ".pin" || command === ".pinterest") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.pin estetik wallpaper*",
            });
          await sock.sendMessage(sender, {
            text: "📌 Mencari gambar Pinterest...",
          });

          try {
            const imgUrl = `https://image.thum.io/get/width/800/crop/600/https://id.pinterest.com/search/pins/?q=${encodeURIComponent(args)}`;
            const res = await axios.get(imgUrl, {
              responseType: "arraybuffer",
            });
            await sock.sendMessage(sender, {
              image: Buffer.from(res.data),
              caption: `📌 *Hasil Pencarian Pinterest*: ${args}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil gambar Pinterest.",
            });
          }
        }

        if (command === ".capcut") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.capcut https://www.capcut.com/t/xxxx*",
            });
          await sock.sendMessage(sender, {
            text: "🎬 Mengunduh video CapCut...",
          });

          try {
            const res = await axios
              .get(
                `https://api.vreden.web.id/api/capcut?url=${encodeURIComponent(args)}`,
              )
              .catch(() => null);
            if (res && res.data && res.data.result) {
              const videoUrl =
                res.data.result.video_ori || res.data.result.video;
              const v = await axios.get(videoUrl, {
                responseType: "arraybuffer",
              });
              return sock.sendMessage(sender, {
                video: Buffer.from(v.data),
                mimetype: "video/mp4",
                caption: `🎬 *CapCut Template*: ${res.data.result.title || "Video"}`,
              });
            }
            await sock.sendMessage(sender, {
              text: "Gagal mengambil video CapCut.",
            });
          } catch (e) {
            await sock.sendMessage(sender, { text: "Gagal mengunduh CapCut." });
          }
        }

        // ==========================================
        // 🌐 NEW API FEATURES (Weather, Currency, Wiki, Lyrics, Anime, KBBI, Zodiak)
        // ==========================================
        if (command === ".cuaca") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.cuaca Jakarta*",
            });
          await sock.sendMessage(sender, {
            text: "🌤️ Mengambil data cuaca...",
          });

          try {
            const res = await axios.get(
              `https://wttr.in/${encodeURIComponent(args)}?format=j1`,
            );
            const curr = res.data.current_condition[0];
            const area = res.data.nearest_area[0];

            const weatherText = `
🌤️ *INFORMASI CUACA (${area.areaName[0].value}, ${area.country[0].value})*
────────────────
🌡️ Suhu : *${curr.temp_C}°C* (Terasa: ${curr.FeelsLikeC}°C)
☁️ Cuaca : *${curr.weatherDesc[0].value}*
💧 Kelembaban : *${curr.humidity}%*
💨 Kecepatan Angin : *${curr.windspeedKmph} km/jam*
`;
            await sock.sendMessage(sender, { text: weatherText.trim() });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "❌ Kota tidak ditemukan atau API Error.",
            });
          }
        }

        if (command === ".kurs") {
          const parts = args.split(" ");
          if (parts.length < 3) {
            return sock.sendMessage(sender, {
              text: "Contoh: *.kurs 100 USD IDR* atau *.kurs 50000 IDR USD*",
            });
          }
          const amount = parseFloat(parts[0]);
          const from = parts[1].toUpperCase();
          const to = parts[2].toUpperCase();

          if (isNaN(amount))
            return sock.sendMessage(sender, {
              text: "Jumlah angka tidak valid.",
            });
          await sock.sendMessage(sender, {
            text: "💱 Menghitung nilai tukar kurs...",
          });

          try {
            const res = await axios.get(
              `https://open.er-api.com/v6/latest/${from}`,
            );
            const rate = res.data.rates[to];
            if (!rate)
              return sock.sendMessage(sender, {
                text: `Mata uang '${to}' tidak ditemukan.`,
              });

            const result = (amount * rate).toLocaleString("id-ID", {
              maximumFractionDigits: 2,
            });
            await sock.sendMessage(sender, {
              text: `💱 *HASIL KONVERSI KURS*\n\n💰 *${amount} ${from}* = *${result} ${to}*\n📈 Kurs: 1 ${from} = ${rate.toFixed(2)} ${to}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil data kurs mata uang.",
            });
          }
        }

        if (command === ".wiki") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.wiki Albert Einstein*",
            });
          await sock.sendMessage(sender, {
            text: "📖 Mencari di Wikipedia...",
          });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah pustakawan Wikipedia. Berikan ringkasan Wikipedia yang sangat informatif, akurat, dan rapi dari topik yang diminta dalam Bahasa Indonesia.",
              },
              {
                role: "user",
                content: `Berikan ringkasan rincian Wikipedia tentang: ${args}`,
              },
            ]);
            await sock.sendMessage(sender, {
              text: `📖 *WIKIPEDIA SUMMARY*\n📌 *Topik*: ${args}\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil data Wikipedia.",
            });
          }
        }

        if (command === ".lirik") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.lirik Komang - Raim Laode*",
            });
          await sock.sendMessage(sender, { text: "🎵 Mencari lirik lagu..." });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Tuliskan lirik lagu lengkap beserta penyanyi dan judulnya secara rapi tanpa penjelasan bertele-tele.",
              },
              { role: "user", content: `Carikan lirik lagu: ${args}` },
            ]);
            await sock.sendMessage(sender, {
              text: `🎶 *LIRIK LAGU*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mencari lirik lagu.",
            });
          }
        }

        if (command === ".anime") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.anime Naruto*",
            });
          await sock.sendMessage(sender, { text: "⛩️ Mencari data anime..." });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah otaku serba tahu. Berikan informasi lengkap anime (Judul, Genre, Skor, Episode, Status, Sinopsis singkat) secara menarik dan rapi.",
              },
              {
                role: "user",
                content: `Berikan info & sinopsis anime: ${args}`,
              },
            ]);
            await sock.sendMessage(sender, {
              text: `⛩️ *INFO ANIME*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mencari data anime.",
            });
          }
        }

        if (command === ".kbbi") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.kbbi rekayasa*",
            });
          await sock.sendMessage(sender, {
            text: "📚 Mencari definisi di KBBI...",
          });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah Ahli Bahasa Indonesia. Berikan arti/definisi kata sesuai Kamus Besar Bahasa Indonesia (KBBI) lengkap dengan contoh penggunaannya dalam kalimat.",
              },
              { role: "user", content: `Apa arti kata KBBI dari: ${args}` },
            ]);
            await sock.sendMessage(sender, {
              text: `📚 *KAMUS BESAR BAHASA INDONESIA (KBBI)*\n📌 Kata: *${args}*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mencari definisi kata.",
            });
          }
        }

        if (command === ".zodiak") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.zodiak Aries* (Tersedia: Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces)",
            });
          await sock.sendMessage(sender, {
            text: "🔮 Membaca ramalan zodiak...",
          });

          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah peramal Zodiak terkenal. Berikan ramalan zodiak hari ini yang menghibur (Asmara, Karir/Keuangan, Kesehatan, dan Angka Keberuntungan).",
              },
              {
                role: "user",
                content: `Berikan ramalan zodiak untuk: ${args}`,
              },
            ]);
            await sock.sendMessage(sender, {
              text: `🔮 *RAMALAN ZODIAK (${args.toUpperCase()})*\n────────────────\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal membaca ramalan zodiak.",
            });
          }
        }

        if (command === ".quote") {
          try {
            const reply = await callGroqAI([
              {
                role: "system",
                content:
                  "Berikan satu kata-kata bijak / motivasi bermakna mendalam dalam Bahasa Indonesia beserta pembuatnya (tokoh/filsuf).",
              },
              { role: "user", content: "Berikan quote bijak hari ini." },
            ]);
            await sock.sendMessage(sender, {
              text: `💡 *KATA BIJAK HARI INI*\n\n${reply}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, { text: "Gagal mengambil quote." });
          }
        }

        // ==========================================
        // 🎨 STICKER & IMAGE UTILS
        // ==========================================
        if (command === ".s" || command === ".sticker") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          if (!quoted)
            return sock.sendMessage(sender, {
              text: "Reply gambar atau video dengan *.s*",
            });

          try {
            let buffer;
            let isVideo = false;

            if (quoted.imageMessage) {
              buffer = await downloadMedia(quoted.imageMessage, "image");
            } else if (quoted.videoMessage) {
              buffer = await downloadMedia(quoted.videoMessage, "video");
              isVideo = true;
            } else {
              return sock.sendMessage(sender, {
                text: "Kirim/reply gambar atau video singkat.",
              });
            }

            const sticker = new Sticker(buffer, {
              pack: "BotWA OpenCode",
              author: "Royyan Bot",
              type: StickerTypes.FULL,
              quality: 70,
            });

            const stickerBuffer = await sticker.toBuffer();
            await sock.sendMessage(sender, { sticker: stickerBuffer });
          } catch (err) {
            console.error(err);
            await sock.sendMessage(sender, {
              text: "❌ Gagal membuat stiker.",
            });
          }
        }

        if (command === ".toimg") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted || !quoted.stickerMessage) {
            return sock.sendMessage(sender, {
              text: "Reply stiker diam dengan *.toimg*",
            });
          }

          try {
            const buffer = await downloadMedia(
              quoted.stickerMessage,
              "sticker",
            );
            const outputPath = `./tmp_${Date.now()}.png`;

            await sharp(buffer).toFormat("png").toFile(outputPath);
            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: "✨ Hasil stiker ke gambar",
            });
            fs.unlinkSync(outputPath);
          } catch (err) {
            console.error(err);
            await sock.sendMessage(sender, {
              text: "Gagal konversi stiker ke gambar.",
            });
          }
        }

        if (command === ".hd" || command === ".remini") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMessage =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMessage)
            return sock.sendMessage(sender, {
              text: "Reply foto yang mau dijernihkan dengan *.hd*",
            });

          try {
            await sock.sendMessage(sender, {
              text: "🎨 Memproses penjernihan foto...",
            });
            const buffer = await downloadMedia(imgMessage, "image");
            const outputPath = `./tmp_hd_${Date.now()}.png`;

            const img = sharp(buffer);
            const meta = await img.metadata();

            await img
              .resize(Math.round(meta.width * 2), Math.round(meta.height * 2), {
                kernel: "lanczos3",
              })
              .sharpen()
              .toFile(outputPath);

            await sock.sendMessage(sender, {
              image: fs.readFileSync(outputPath),
              caption: "✨ Kualitas foto berhasil ditingkatkan!",
            });
            fs.unlinkSync(outputPath);
          } catch (err) {
            console.error(err);
            await sock.sendMessage(sender, {
              text: "Gagal memproses gambar HD.",
            });
          }
        }

        // ==========================================
        // 🌐 WEB GENERATOR & VERCEL DEPLOY
        // ==========================================
        if (command === ".web") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.web landing page toko sepatu modern*",
            });
          await sock.sendMessage(sender, {
            text: "🚀 Sedang membuat website & mempersiapkan deploy...",
          });

          try {
            const htmlCode = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah Fullstack Web Developer hebat. Buat kode HTML5 lengkap yang responsif, modern, dan memakai inline CSS/JS cantik dalam satu file index.html saja. Jangan beri penjelasan apapun di luar kode HTML.",
              },
              { role: "user", content: `Buat website dengan topik: ${args}` },
            ]);

            let cleanHtml = htmlCode
              .replace(/```html/gi, "")
              .replace(/```/g, "")
              .trim();

            await fs.ensureDir("site");
            await fs.writeFile("site/index.html", cleanHtml);

            exec(
              "vercel --prod --yes",
              { cwd: "site" },
              async (err, stdout, stderr) => {
                if (err) {
                  console.error(err);
                  return sock.sendMessage(sender, {
                    text: "❌ Gagal deploy ke Vercel (Pastikan sudah 'vercel login').",
                  });
                }

                let url = "Deploy selesai! Cek dashboard Vercel kamu.";
                const urls = stdout.match(/https:\/\/[^\s]+\.vercel\.app/g);
                if (urls && urls.length > 0) {
                  url = urls[urls.length - 1];
                }

                await sock.sendMessage(sender, {
                  text: `🌐 *Website Berhasil Di-deploy!*\n🔗 URL: ${url}`,
                });
              },
            );
          } catch (e) {
            console.error(e);
            await sock.sendMessage(sender, { text: "Gagal membuat website." });
          }
        }

        // ==========================================
        // 🔍 OCR SCAN & SOLVE
        // ==========================================
        if (command === ".scan") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply/kirim foto dengan *.scan*",
            });

          try {
            await sock.sendMessage(sender, {
              text: "🔍 Membaca teks pada gambar...",
            });
            const buffer = await downloadMedia(imgMsg, "image");
            const filename = `./tmp_${crypto.randomBytes(6).toString("hex")}.jpg`;
            fs.writeFileSync(filename, buffer);

            const result = await Tesseract.recognize(filename, "eng+ind", {
              logger: () => {},
            });
            fs.unlinkSync(filename);

            const outputText = result.data.text.trim();
            if (!outputText)
              return sock.sendMessage(sender, {
                text: "Teks tidak terdeteksi pada gambar.",
              });

            await sock.sendMessage(sender, {
              text: `📄 *Hasil Scan Teks*:\n\n${outputText}`,
            });
          } catch (err) {
            console.error(err);
            await sock.sendMessage(sender, {
              text: "Gagal melakukan scan OCR.",
            });
          }
        }

        if (command === ".solve") {
          const quoted =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            msg.message;
          const imgMsg =
            quoted.imageMessage ||
            quoted.extendedTextMessage?.contextInfo?.quotedMessage
              ?.imageMessage;

          if (!imgMsg)
            return sock.sendMessage(sender, {
              text: "Reply/kirim foto soal dengan *.solve*",
            });

          try {
            await sock.sendMessage(sender, {
              text: "📑 Membaca & memecahkan soal...",
            });
            const buffer = await downloadMedia(imgMsg, "image");
            const filename = `./tmp_${Date.now()}.jpg`;
            fs.writeFileSync(filename, buffer);

            const ocr = await Tesseract.recognize(filename, "ind+eng", {
              logger: () => {},
            });
            fs.unlinkSync(filename);

            const extractedText = ocr.data.text.trim();
            if (!extractedText)
              return sock.sendMessage(sender, {
                text: "Tidak ada teks soal yang terbaca.",
              });

            const answer = await callGroqAI([
              {
                role: "system",
                content:
                  "Kamu adalah Guru & Pemecah Soal Serbaguna. Analisis teks soal berikut, berikan penjelasan langkah demi langkah yang runtut, logis, dan tuliskan jawaban akhirnya secara rinci.",
              },
              { role: "user", content: extractedText },
            ]);

            await sock.sendMessage(sender, {
              text: `🧮 *Solusi Soal*:\n\n${answer}`,
            });
          } catch (err) {
            console.error(err);
            await sock.sendMessage(sender, { text: "Gagal memecahkan soal." });
          }
        }

        // ==========================================
        // 💤 SLEEP TRACKER
        // ==========================================
        if (command === ".tidur") {
          if (user.sleeping)
            return sock.sendMessage(sender, {
              text: "Lu udah dalam mode tidur. Ketik *.bangun* kalau udah bangun.",
            });

          user.sleeping = true;
          user.sleepStart = now;
          saveDB(db);

          return sock.sendMessage(sender, {
            text: "🌙 *Sleep Mode Aktif*! Selamat tidur. Ketik *.bangun* saat Anda bangun.",
          });
        }

        if (command === ".bangun") {
          if (!user.sleeping)
            return sock.sendMessage(sender, {
              text: "Lu ga lagi dalam mode tidur.",
            });

          const start = user.sleepStart;
          const durationMs = now - start;
          const dur = formatDuration(durationMs);
          const analysis = analyzeSleep(durationMs);

          user.sleeping = false;
          user.sleepStart = 0;
          saveDB(db);

          const reportText = `
📊 *LAPORAN WAKTU TIDUR*
────────────────
🕒 Mulai  : ${formatTime(start)}
☀️ Bangun : ${formatTime(now)}
⏱️ Durasi : *${dur.text}*
────────────────
Status   : *${analysis.status}*
Analisis : ${analysis.note}
`;
          return sock.sendMessage(sender, { text: reportText.trim() });
        }

        // ==========================================
        // 👥 GROUP UTILS & FUN
        // ==========================================
        if (command === ".tagall") {
          if (!isGroup)
            return sock.sendMessage(sender, {
              text: "Perintah ini hanya bisa dipakai di dalam grup!",
            });

          try {
            const groupMetadata = await sock.groupMetadata(sender);
            const participants = groupMetadata.participants;

            let tagText = `📣 *TAG ALL MEMBERS*\n💬 Pesan: ${args || "Perhatian semua!"}\n\n`;
            let mentions = [];

            for (let mem of participants) {
              tagText += `@${mem.id.split("@")[0]}\n`;
              mentions.push(mem.id);
            }

            await sock.sendMessage(sender, { text: tagText, mentions });
          } catch (e) {
            console.error(e);
            await sock.sendMessage(sender, { text: "Gagal melakukan tagall." });
          }
        }

        if (command === ".hidetag") {
          if (!isGroup)
            return sock.sendMessage(sender, { text: "Perhatian semua!" });

          try {
            const groupMetadata = await sock.groupMetadata(sender);
            const participants = groupMetadata.participants;
            const mentions = participants.map((p) => p.id);

            await sock.sendMessage(sender, {
              text: args || "Pemberitahuan!",
              mentions,
            });
          } catch (e) {
            await sock.sendMessage(sender, { text: "Gagal hidetag." });
          }
        }

        if (command === ".ssweb") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Contoh: *.ssweb https://google.com*",
            });
          let targetUrl = args.trim();
          if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

          await sock.sendMessage(sender, {
            text: "📸 Mengambil screenshot website...",
          });

          try {
            const ssUrl = `https://image.thum.io/get/width/1200/crop/800/${targetUrl}`;
            const res = await axios.get(ssUrl, { responseType: "arraybuffer" });
            await sock.sendMessage(sender, {
              image: Buffer.from(res.data),
              caption: `🌐 Screenshot dari: ${targetUrl}`,
            });
          } catch (e) {
            await sock.sendMessage(sender, {
              text: "Gagal mengambil screenshot website.",
            });
          }
        }

        if (command === ".dadu") {
          const rand = Math.floor(Math.random() * 6) + 1;
          return sock.sendMessage(sender, {
            text: `🎲 Kamu melempar dadu dan mendapatkan angka: *${rand}*`,
          });
        }

        if (command === ".kerang") {
          if (!args)
            return sock.sendMessage(sender, {
              text: "Tanyakan sesuatu ke kerang ajaib!",
            });
          const answers = [
            "Ya.",
            "Tidak.",
            "Mungkin suatu hari nanti.",
            "Coba tanya lagi nanti.",
            "Sangat tidak mungkin.",
          ];
          const result = answers[Math.floor(Math.random() * answers.length)];
          return sock.sendMessage(sender, {
            text: `🐚 *Kerang Ajaib berkata*: "${result}"`,
          });
        }
      } catch (err) {
        console.error("❌ Error executing command:", err.message || err);
      }
    }
  });
}

startBot();
