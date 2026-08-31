'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bungkus sebuah promise dengan batas waktu. Kalau melewati `ms`, promise
 * ditolak dengan pesan `label` supaya satu operasi yang macet (mis. ambil
 * daftar grup atau kirim pesan yang menggantung) tidak membekukan seluruh
 * siklus auto post. Timer selalu dibersihkan agar tidak menahan proses hidup.
 */
function withTimeout(promise, ms, label = 'operasi timeout') {
  let to;
  const batas = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} (> ${Math.round(ms / 1000)} detik)`)), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(to)), batas]);
}

/** Angka acak antara min..max (inklusif). */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Format tanggal/jam mengikuti timezone di config. */
function nowParts(timezone = 'Asia/Jakarta') {
  const d = new Date();
  const fmt = (opts, locale = 'id-ID') =>
    new Intl.DateTimeFormat(locale, { timeZone: timezone, ...opts }).format(d);
  return {
    date: d,
    tanggal: fmt({ day: '2-digit', month: 'long', year: 'numeric' }),
    tanggalPendek: fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }),
    // pakai en-GB supaya formatnya "16:57" (id-ID menghasilkan "16.57")
    jam: fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'en-GB'),
    hari: fmt({ weekday: 'long' }),
    // 0 = Minggu ... 6 = Sabtu, dihitung pada timezone target
    dayIndex: new Date(d.toLocaleString('en-US', { timeZone: timezone })).getDay(),
    minutesOfDay: (() => {
      const t = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
      return t.getHours() * 60 + t.getMinutes();
    })(),
  };
}

/** Ganti placeholder {{...}} di dalam teks pesan. */
function renderTemplate(text, ctx) {
  if (!text) return '';
  const map = {
    tanggal: ctx.tanggal,
    tanggalPendek: ctx.tanggalPendek,
    jam: ctx.jam,
    hari: ctx.hari,
    namaGrup: ctx.namaGrup || '',
    namaBot: ctx.namaBot || '',
    idGrup: ctx.idGrup || '',
  };
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key) =>
    Object.prototype.hasOwnProperty.call(map, key) ? String(map[key]) : full
  );
}

/** "HH:MM" -> menit sejak tengah malam. */
function hhmmToMinutes(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/** Cek apakah sekarang termasuk jam & hari aktif. */
function dalamJadwalAktif(jadwal, timezone) {
  const t = nowParts(timezone);
  if (Array.isArray(jadwal.hariAktif) && !jadwal.hariAktif.map(Number).includes(t.dayIndex)) {
    return { ok: false, alasan: `hari ${t.hari} tidak termasuk hariAktif` };
  }
  const ja = jadwal.jamAktif || {};
  if (!ja.aktif) return { ok: true };
  const start = hhmmToMinutes(ja.mulai, 0);
  const end = hhmmToMinutes(ja.selesai, 1439);
  const cur = t.minutesOfDay;
  const inside = start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
  return inside ? { ok: true } : { ok: false, alasan: `di luar jam aktif ${ja.mulai}-${ja.selesai}` };
}

/**
 * Ubah nilai "gambar" di config jadi payload yang dimengerti Baileys.
 * Mendukung: URL http(s), path relatif ke folder project, atau path absolut.
 */
function resolveMedia(ref) {
  const s = (ref || '').toString().trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { url: s };

  const candidates = [
    path.isAbsolute(s) ? s : path.join(PATHS.root, s),
    path.join(PATHS.media, s),
    path.join(PATHS.media, path.basename(s)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { buffer: fs.readFileSync(c), path: c };
  }
  throw new Error(`File gambar tidak ditemukan: "${s}" (dicari di: ${candidates.join(' | ')})`);
}

/** Potong teks panjang untuk keperluan log. */
const ringkas = (s, n = 60) =>
  !s ? '' : s.replace(/\s+/g, ' ').slice(0, n) + (s.length > n ? '…' : '');

module.exports = {
  delay,
  withTimeout,
  randInt,
  nowParts,
  renderTemplate,
  hhmmToMinutes,
  dalamJadwalAktif,
  resolveMedia,
  ringkas,
};
