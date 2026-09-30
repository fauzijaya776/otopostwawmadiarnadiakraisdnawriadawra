#!/usr/bin/env node
'use strict';

/**
 * Auto invite anggota ke grup WhatsApp dengan tempo aman (anti-spam).
 *
 *   npm run invite            jalankan (login pakai sesi yang sama dengan bot auto-post)
 *   npm run invite -- --dry-run   simulasi: cek nomor & hitung, TANPA menambah/mengirim
 *
 * Nomor dibaca dari file di config "undangan.fileNomor" (default: data/nomor.txt),
 * satu nomor per baris. Progress disimpan di data/invite-progress.json sehingga
 * aman dihentikan (Ctrl+C) dan dilanjutkan kapan saja.
 *
 * SYARAT:
 *   - Bot sudah pernah login (folder session/ terisi). Kalau belum, script ini
 *     akan menampilkan pairing code / QR seperti biasa.
 *   - Nomor bot HARUS admin di grup tujuan.
 */

require('dotenv').config();

const { loadConfig } = require('../src/config');
const { logger, banner } = require('../src/logger');
const { WhatsAppClient } = require('../src/whatsapp');
const { Inviter } = require('../src/invite');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run') || argv.includes('--dry');

async function main() {
  banner('WHATSAPP AUTO INVITE');
  console.log('  Login : sesi yang sama dengan bot auto-post (folder session/)');
  console.log('  Node  : ' + process.version);
  if (DRY_RUN) console.log('  Mode  : DRY-RUN (simulasi, tidak menambah/mengirim apa pun)');
  console.log('');

  const getConfig = () => loadConfig();
  const cfg = loadConfig(true);

  if (!cfg.undangan) {
    logger.error('❌ Blok "undangan" belum ada di config.json. Tambahkan dulu (lihat README).');
    process.exit(1);
  }
  const grupAda =
    Array.isArray(cfg.undangan.grupTujuan) && cfg.undangan.grupTujuan.filter(Boolean).length > 0;
  if (!grupAda) {
    logger.error('❌ "undangan.grupTujuan" masih kosong. Isi ID grup tujuan dulu.');
    logger.error('   Ambil ID grup dengan: npm run groups');
    process.exit(1);
  }

  const wa = new WhatsAppClient({ getConfig });
  const inviter = new Inviter({ wa, getConfig, dryRun: DRY_RUN });

  let selesai = false;
  const shutdown = async (sinyal) => {
    if (selesai) return;
    logger.warn(`\n🛑 ${sinyal} — menyelesaikan nomor berjalan lalu berhenti (progress disimpan)…`);
    inviter.stop();
    setTimeout(async () => {
      try {
        await wa.stop();
      } catch {
        /* noop */
      }
      process.exit(0);
    }, 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) =>
    logger.error({ err: e?.message || String(e) }, '⚠️  unhandledRejection')
  );

  // Jalankan Inviter setelah WhatsApp benar-benar siap.
  wa.once('ready', async () => {
    try {
      await inviter.jalankan();
    } catch (e) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, '💥 Auto invite berhenti karena error');
    } finally {
      selesai = true;
      try {
        await wa.stop();
      } catch {
        /* noop */
      }
      // beri waktu socket menutup rapi
      setTimeout(() => process.exit(0), 1500).unref();
    }
  });

  await wa.start();
}

main().catch((e) => {
  logger.error({ err: e?.message || String(e) }, '💥 Gagal start auto invite');
  process.exit(1);
});
