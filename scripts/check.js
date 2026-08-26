#!/usr/bin/env node
'use strict';

/**
 * Cek config.json tanpa menyambung ke WhatsApp.
 * Menampilkan: validasi, jadwal, grup tujuan, dan pratinjau pesan.
 * Jalankan: npm run check
 */

require('dotenv').config();

const { loadConfig, validateConfig } = require('../src/config');
const { nowParts, renderTemplate, dalamJadwalAktif, resolveMedia } = require('../src/utils');
const { banner } = require('../src/logger');
const { punyaSesi } = require('../src/session');

const cfg = loadConfig(true);
const t = nowParts(cfg.bot.timezone);

banner('CEK KONFIGURASI');

const masalah = validateConfig(cfg);
if (masalah.length === 0) console.log('✅ Konfigurasi terlihat benar.\n');
else {
  console.log('⚠️  Perlu diperbaiki:');
  masalah.forEach((m) => console.log('   • ' + m));
  console.log('');
}

console.log('— Umum —');
console.log(`  Nama bot   : ${cfg.bot.namaBot}`);
console.log(`  Nomor bot  : ${cfg.bot.nomorBot ? '+' + cfg.bot.nomorBot : '(kosong)'}`);
console.log(`  Timezone   : ${cfg.bot.timezone}  (sekarang ${t.hari}, ${t.tanggal} ${t.jam})`);
console.log(`  Sesi login : ${punyaSesi() ? 'ADA (tidak perlu pairing ulang)' : 'BELUM ADA (akan minta pairing code)'}`);

const cek = dalamJadwalAktif(cfg.jadwal, cfg.bot.timezone);
console.log('\n— Jadwal —');
console.log(`  Aktif             : ${cfg.jadwal.aktif}`);
console.log(`  Interval          : setiap ${cfg.jadwal.intervalMenit} menit`);
console.log(`  Kirim saat start  : ${cfg.jadwal.kirimSaatStart} (delay ${cfg.jadwal.delaySebelumKirimPertamaDetik} detik)`);
console.log(`  Jeda antar grup   : ${cfg.jadwal.jedaAntarGrupDetik}s (+ jitter s/d ${cfg.jadwal.jitterDetik}s)`);
console.log(`  Jam aktif         : ${cfg.jadwal.jamAktif.aktif ? cfg.jadwal.jamAktif.mulai + ' - ' + cfg.jadwal.jamAktif.selesai : 'nonaktif (24 jam)'}`);
console.log(`  Status sekarang   : ${cek.ok ? 'BOLEH KIRIM' : 'TIDAK KIRIM (' + cek.alasan + ')'}`);

console.log('\n— Grup tujuan —');
cfg.grupTujuan.forEach((g, i) => {
  const tanda = g.aktif ? '●' : '○';
  console.log(`  ${tanda} ${i + 1}. ${g.nama || '(tanpa nama)'}`);
  console.log(`       id: ${g.id || '(kosong -> akan dicari dari nama saat bot terhubung)'}`);
});
if (cfg.grupTujuan.length === 0) console.log('  (kosong)');

console.log(`\n— Pesan (mode: ${cfg.pesan.mode}) —`);
cfg.pesan.daftar.forEach((m, i) => {
  const tanda = m.aktif ? '●' : '○';
  let statusGambar = '-';
  if (m.gambar) {
    try {
      const r = resolveMedia(m.gambar);
      statusGambar = r.url ? `URL ok (${r.url})` : `file ok (${r.path})`;
    } catch (e) {
      statusGambar = '❌ ' + e.message;
    }
  }
  const preview = renderTemplate(m.teks, {
    ...t,
    namaGrup: 'Nama Grup Contoh',
    namaBot: cfg.bot.namaBot,
    idGrup: '1203630000@g.us',
  });
  console.log(`\n  ${tanda} Pesan #${i + 1}`);
  console.log(`     gambar : ${statusGambar}`);
  console.log('     teks   : ' + preview.split('\n').join('\n              '));
});

console.log('\n');
process.exit(masalah.length ? 1 : 0);
