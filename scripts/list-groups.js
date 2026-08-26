#!/usr/bin/env node
'use strict';

/**
 * Tampilkan ID + nama semua grup yang diikuti bot.
 *
 *   npm run groups            ambil ulang dari WhatsApp (perlu bot sudah login)
 *   npm run groups:offline    baca dari groups.json yang sudah tersimpan
 *   npm run groups:snippet    cetak blok "grupTujuan" siap tempel ke config.json
 *
 * Hasilnya juga ditulis ke daftar-grup.txt supaya gampang dibuka & dicari.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { PATHS } = require('../src/paths');
const { logger, banner } = require('../src/logger');

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const SNIPPET = argv.includes('--snippet');

/** Grup yang bot-nya tidak akan bisa kirim ke situ. */
function terkunci(g) {
  return g.hanyaAdminBisaKirim && g.botAdmin !== true;
}

function bacaTersimpan() {
  const isi = JSON.parse(fs.readFileSync(PATHS.groupsJson, 'utf8'));
  return { grup: isi.grup || [], diambilPada: isi.diambilPada };
}

function tampilkan(grup, diambilPada) {
  // Grup ramai lebih dulu — itu yang biasanya dicari untuk auto post.
  const urut = grup.slice().sort((a, b) => (b.jumlahAnggota || 0) - (a.jumlahAnggota || 0));

  const baris = [];
  const tulis = (s) => {
    baris.push(s);
    console.log(s);
  };

  banner(`DAFTAR GRUP (${grup.length} grup)`);
  if (diambilPada) tulis(`  Diambil: ${new Date(diambilPada).toLocaleString('id-ID')}`);
  tulis(`  Bisa dikirimi : ${urut.filter((g) => !terkunci(g)).length}`);
  tulis(`  Terkunci admin: ${urut.filter(terkunci).length}  (bot bukan admin, hanya admin boleh kirim)`);
  tulis('');

  urut.forEach((g, i) => {
    const tanda = terkunci(g) ? '🔒' : '  ';
    const label = [
      `${g.jumlahAnggota} anggota`,
      g.botAdmin === true ? 'bot admin' : null,
      terkunci(g) ? 'TIDAK BISA KIRIM' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    // Nama grup sering memakai huruf unicode/emoji dan bisa multi-baris.
    const nama = (g.nama || '(tanpa nama)').replace(/\s*\n\s*/g, ' ').trim();
    tulis(`${tanda}${String(i + 1).padStart(3)}. ${nama}`);
    tulis(`       ${g.id}`);
    tulis(`       ${label}`);
  });

  tulis('');
  tulis('Cara pakai: salin baris ID grup yang kamu mau ke "grupTujuan" di config.json.');
  tulis('Atau jalankan: npm run groups:snippet');

  const berkas = path.join(PATHS.root, 'daftar-grup.txt');
  fs.writeFileSync(berkas, baris.join('\n') + '\n', 'utf8');
  console.log(`\n📄 Disimpan juga ke: ${berkas}\n`);
}

function snippet(grup) {
  const bisa = grup
    .filter((g) => !terkunci(g))
    .sort((a, b) => (b.jumlahAnggota || 0) - (a.jumlahAnggota || 0));

  const entri = bisa.map((g) => ({
    aktif: false, // sengaja false: nyalakan sendiri yang kamu mau
    nama: (g.nama || '').replace(/\s*\n\s*/g, ' ').trim(),
    id: g.id,
  }));

  banner('BLOK grupTujuan SIAP TEMPEL');
  console.log('Semua "aktif" sengaja false. Ubah jadi true hanya untuk grup yang');
  console.log('mau dikirimi, lalu tempel menggantikan "grupTujuan" di config.json.\n');
  console.log('  "grupTujuan": ' + JSON.stringify(entri, null, 2).split('\n').join('\n  ') + ',');

  const berkas = path.join(PATHS.root, 'grupTujuan.snippet.json');
  fs.writeFileSync(berkas, JSON.stringify({ grupTujuan: entri }, null, 2) + '\n', 'utf8');
  console.log(`\n📄 Disimpan juga ke: ${berkas}\n`);
}

(async () => {
  let grup;
  let diambilPada;

  if (OFFLINE || SNIPPET) {
    try {
      ({ grup, diambilPada } = bacaTersimpan());
    } catch {
      logger.error('❌ groups.json belum ada. Jalankan "npm run groups" dulu (bot harus sudah login).');
      process.exit(1);
    }
  } else {
    // Ambil ulang dari WhatsApp.
    const { WhatsAppClient } = require('../src/whatsapp');
    const { simpanDanTampilkan } = require('../src/groups');
    const wa = new WhatsAppClient({ getConfig: () => loadConfig() });

    const batas = setTimeout(() => {
      logger.error('⏰ Timeout 3 menit — belum berhasil terhubung. Coba lagi.');
      process.exit(1);
    }, 3 * 60 * 1000);

    grup = await new Promise((resolve) => {
      wa.on('ready', async () => {
        try {
          resolve(await wa.ambilSemuaGrup());
        } catch (e) {
          logger.error({ err: e.message }, 'Gagal mengambil daftar grup');
          resolve([]);
        }
      });
      wa.start().catch((e) => {
        logger.error({ err: e.message }, 'Gagal start');
        resolve([]);
      });
    });

    clearTimeout(batas);
    simpanDanTampilkan(grup, { tulisFile: true, tampilkan: false });
    diambilPada = new Date().toISOString();
    await wa.stop();
  }

  if (SNIPPET) snippet(grup);
  else tampilkan(grup, diambilPada);

  process.exit(0);
})();
