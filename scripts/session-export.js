#!/usr/bin/env node
'use strict';

/**
 * Ubah folder ./session jadi satu string base64 untuk ditempel
 * ke environment variable SESSION_B64 di Render.
 * Jalankan: npm run session:export
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exportBase64 } = require('../src/session');
const { banner } = require('../src/logger');
const { PATHS } = require('../src/paths');

try {
  const b64 = exportBase64();
  const out = path.join(PATHS.data, 'session-b64.txt');
  fs.writeFileSync(out, b64, 'utf8');

  banner('EXPORT SESI BERHASIL');
  console.log(`  Panjang : ${b64.length} karakter`);
  console.log(`  File    : ${out}`);
  console.log('');
  console.log('  Langkah berikutnya:');
  console.log('  1. Buka file di atas, salin SELURUH isinya.');
  console.log('  2. Render > service kamu > Environment > Add Environment Variable');
  console.log('  3. Key: SESSION_B64   Value: (tempel hasil salinan)');
  console.log('  4. Save & deploy. Bot tidak akan minta pairing code lagi.\n');
  console.log('  ⚠️  Rahasiakan nilai ini — siapa pun yang punya string ini bisa memakai akun WA-mu.\n');
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}
