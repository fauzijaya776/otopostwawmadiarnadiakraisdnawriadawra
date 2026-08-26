'use strict';

const fs = require('fs');
const { PATHS } = require('./paths');
const { logger } = require('./logger');

const DEFAULTS = {
  bot: { nomorBot: '', namaBot: 'AutoPost Bot', timezone: 'Asia/Jakarta', modeLogin: 'pairing' },
  jadwal: {
    aktif: true,
    intervalMenit: 30,
    kirimSaatStart: true,
    delaySebelumKirimPertamaDetik: 25,
    jedaAntarGrupDetik: 8,
    jitterDetik: 5,
    jamAktif: { aktif: false, mulai: '00:00', selesai: '23:59' },
    hariAktif: [0, 1, 2, 3, 4, 5, 6],
  },
  grupTujuan: [],
  pesan: { mode: 'urut', acakUrutanGambar: false, daftar: [] },
  opsi: {
    tulisGroupsJson: true,
    isiOtomatisIdGrupDariNama: true,
    tandaiSudahDibaca: false,
    tampilkanSedangMengetik: true,
    hentikanJikaSemuaGrupGagal: false,
  },
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (override === null || typeof override !== 'object') {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const b = base ? base[key] : undefined;
    out[key] =
      b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, override[key]) : override[key];
  }
  return out;
}

let cache = null;
let cacheMtime = 0;
const listeners = new Set();

function readRaw() {
  const txt = fs.readFileSync(PATHS.config, 'utf8');
  // Hanya baris yang SELURUHNYA komentar (diawali //) yang dibuang,
  // supaya teks pesan yang mengandung "https://..." tetap aman.
  const cleaned = txt
    .replace(/^\uFEFF/, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return JSON.parse(cleaned);
}

function normalize(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {});

  // Nomor bot: ENV menang di atas config.json (praktis untuk deploy).
  const envPhone = (process.env.WA_PHONE_NUMBER || '').trim().replace(/[^0-9]/g, '');
  const filePhone = (cfg.bot.nomorBot || '').toString().replace(/[^0-9]/g, '');
  cfg.bot.nomorBot = envPhone || filePhone;
  // Sumber nomor disimpan supaya bisa diperingatkan kalau .env dan config.json beda
  // — beda nomor = pairing code dikirim ke nomor lain dan pasti ditolak HP.
  cfg.bot._sumberNomor = envPhone ? 'WA_PHONE_NUMBER (.env)' : 'config.json';
  // 'qr' berguna kalau pairing code kena rate limit (429 rate-overlimit).
  const modeEnv = (process.env.LOGIN_MODE || '').trim().toLowerCase();
  cfg.bot.modeLogin = (modeEnv || cfg.bot.modeLogin || 'pairing') === 'qr' ? 'qr' : 'pairing';
  cfg.bot._nomorBentrok = envPhone && filePhone && envPhone !== filePhone ? filePhone : null;

  const j = cfg.jadwal;
  j.intervalMenit = Math.max(1, Number(j.intervalMenit) || 30);
  j.jedaAntarGrupDetik = Math.max(0, Number(j.jedaAntarGrupDetik) || 0);
  j.jitterDetik = Math.max(0, Number(j.jitterDetik) || 0);
  j.delaySebelumKirimPertamaDetik = Math.max(0, Number(j.delaySebelumKirimPertamaDetik) || 0);
  if (!Array.isArray(j.hariAktif) || j.hariAktif.length === 0) j.hariAktif = [0, 1, 2, 3, 4, 5, 6];

  cfg.grupTujuan = (Array.isArray(cfg.grupTujuan) ? cfg.grupTujuan : []).map((g) => ({
    aktif: g.aktif !== false,
    nama: (g.nama || '').toString().trim(),
    id: normalizeGroupId(g.id),
  }));

  cfg.pesan.daftar = (Array.isArray(cfg.pesan.daftar) ? cfg.pesan.daftar : []).map((m) => ({
    aktif: m.aktif !== false,
    teks: (m.teks || '').toString(),
    gambar: m.gambar || '',
  }));

  cfg.pesan.mode = ['urut', 'acak'].includes(cfg.pesan.mode) ? cfg.pesan.mode : 'urut';

  return cfg;
}

/** "120363...@g.us", "120363...", atau kosong -> bentuk baku. */
function normalizeGroupId(id) {
  const s = (id || '').toString().trim();
  if (!s) return '';
  if (s.endsWith('@g.us')) return s;
  const digits = s.replace(/[^0-9-]/g, '');
  return digits ? `${digits}@g.us` : '';
}

function loadConfig(force = false) {
  const stat = fs.statSync(PATHS.config);
  if (!force && cache && stat.mtimeMs === cacheMtime) return cache;
  const cfg = normalize(readRaw());
  cache = cfg;
  cacheMtime = stat.mtimeMs;
  return cfg;
}

/** Tulis balik config.json (dipakai saat ID grup diisi otomatis dari nama). */
function saveConfig(mutator) {
  const raw = readRaw();
  const next = mutator(raw) || raw;
  fs.writeFileSync(PATHS.config, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cacheMtime = fs.statSync(PATHS.config).mtimeMs;
  cache = normalize(next);
  return cache;
}

/** Pantau perubahan config.json -> hot reload tanpa restart. */
function watchConfig() {
  fs.watchFile(PATHS.config, { interval: 3000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
      const cfg = loadConfig(true);
      logger.info('♻️  config.json berubah -> pengaturan dimuat ulang');
      for (const fn of listeners) {
        try {
          fn(cfg);
        } catch (e) {
          logger.error({ err: e.message }, 'listener config gagal');
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, '❌ config.json tidak valid, perubahan diabaikan');
    }
  });
}

function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Cek kelayakan config, kembalikan daftar masalah. */
function validateConfig(cfg) {
  const problems = [];
  if (!/^[0-9]{8,20}$/.test(cfg.bot.nomorBot)) {
    problems.push(
      'bot.nomorBot / WA_PHONE_NUMBER belum benar. Pakai format internasional tanpa "+" (contoh: 6281234567890).'
    );
  }
  if (cfg.bot.nomorBot === '6281234567890') {
    problems.push('bot.nomorBot masih nomor contoh (6281234567890). Ganti dengan nomor WhatsApp bot kamu.');
  }
  const aktifGrup = cfg.grupTujuan.filter((g) => g.aktif);
  if (aktifGrup.length === 0) problems.push('Belum ada grup tujuan yang aktif di "grupTujuan".');
  if (aktifGrup.length > 0 && aktifGrup.every((g) => !g.id && !g.nama)) {
    problems.push('Grup tujuan harus punya "id" atau "nama".');
  }
  if (cfg.pesan.daftar.filter((m) => m.aktif && (m.teks || m.gambar)).length === 0) {
    problems.push('Belum ada pesan aktif di "pesan.daftar".');
  }
  return problems;
}

module.exports = {
  loadConfig,
  saveConfig,
  watchConfig,
  onConfigChange,
  validateConfig,
  normalizeGroupId,
};
