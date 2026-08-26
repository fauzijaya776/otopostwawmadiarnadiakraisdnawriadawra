#!/usr/bin/env node
'use strict';

/**
 * Jalankan bot dengan log LENGKAP (termasuk log internal Baileys) dan simpan
 * salinannya ke debug.log. Dipakai kalau pairing/login gagal dan penyebabnya
 * belum kelihatan dari log biasa.
 *
 *   npm run debug
 *
 * Lalu kirimkan isi file debug.log.
 *
 * Bot dijalankan sebagai proses anak dengan stdio di-pipe. Ini penting: pino
 * menulis langsung ke file descriptor, jadi menimpa process.stdout.write di
 * proses ini TIDAK akan menangkap apa pun dari Baileys.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const berkas = path.join(process.cwd(), 'debug.log');
const aliran = fs.createWriteStream(berkas, { flags: 'w' });

console.log(`📝 Log lengkap ditulis ke: ${berkas}`);
console.log('   Tekan Ctrl+C untuk berhenti, lalu kirimkan isi file itu.\n');

const anak = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    BAILEYS_LOG_LEVEL: process.env.BAILEYS_LOG_LEVEL || 'debug',
    LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
    // Paksa keluaran JSON polos: pino-pretty berjalan di worker thread dan
    // keluarannya tidak selalu ikut ter-pipe.
    NO_COLOR: '1',
  },
  stdio: ['inherit', 'pipe', 'pipe'],
});

for (const s of [anak.stdout, anak.stderr]) {
  s.on('data', (buf) => {
    process.stdout.write(buf);
    aliran.write(buf);
  });
}

const teruskan = (sinyal) => anak.kill(sinyal);
process.on('SIGINT', () => teruskan('SIGINT'));
process.on('SIGTERM', () => teruskan('SIGTERM'));

anak.on('exit', (kode) => {
  aliran.end(() => {
    console.log(`\n📝 Selesai. Kirimkan file: ${berkas}`);
    process.exit(kode == null ? 0 : kode);
  });
});
