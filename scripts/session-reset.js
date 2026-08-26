#!/usr/bin/env node
'use strict';

/**
 * Hapus sesi login supaya bot minta pairing code baru.
 * Jalankan: npm run session:reset
 */

const { hapusSesi } = require('../src/session');

if (hapusSesi()) {
  console.log('✅ Folder session dihapus. Jalankan "npm start" lalu masukkan pairing code baru.');
  console.log('   Kalau kamu deploy di Render, hapus juga env SESSION_B64.');
} else {
  console.log('❌ Gagal menghapus folder session.');
  process.exit(1);
}
