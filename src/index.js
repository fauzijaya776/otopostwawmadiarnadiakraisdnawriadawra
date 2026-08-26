'use strict';

require('dotenv').config();

const { logger, banner } = require('./logger');
const { loadConfig, watchConfig, onConfigChange, validateConfig } = require('./config');
const { WhatsAppClient } = require('./whatsapp');
const { Scheduler } = require('./scheduler');
const { simpanDanTampilkan } = require('./groups');
const { buatServer, mulaiKeepAlive } = require('./server');

async function main() {
  banner('WHATSAPP AUTO POST BOT');
  console.log(
    '  Login   : ' +
      (loadConfig().bot.modeLogin === 'qr' ? 'Scan QR' : 'Pairing Code (tanpa scan QR)')
  );
  console.log('  Config  : config.json  (boleh diubah kapan saja, otomatis dibaca ulang)');
  console.log('  Node.js : ' + process.version);
  console.log('');

  let cfg = loadConfig(true);
  const getConfig = () => loadConfig();

  const masalah = validateConfig(cfg);
  if (masalah.length) {
    logger.warn('⚠️  Ada yang perlu dilengkapi di config.json:');
    masalah.forEach((m) => logger.warn('   • ' + m));
    logger.warn('   Bot tetap dijalankan supaya kamu bisa lihat daftar grup & ID-nya dulu.');
  }

  const wa = new WhatsAppClient({ getConfig });
  const scheduler = new Scheduler({ wa, getConfig });

  // HTTP server (wajib untuk Render Web Service) + keepalive free tier
  const { server } = buatServer({ wa, scheduler, getConfig });
  const keepAliveTimer = mulaiKeepAlive();

  // Saat WhatsApp siap: ambil daftar grup lalu nyalakan auto post
  wa.on('ready', async () => {
    try {
      const grup = await wa.ambilSemuaGrup();
      simpanDanTampilkan(grup, {
        tulisFile: getConfig().opsi.tulisGroupsJson,
        tampilkan: true,
      });
      console.log('👉 Salin "id" grup di atas ke "grupTujuan" pada config.json,');
      console.log('   atau cukup tulis "nama" grupnya — ID akan diisi otomatis.\n');
    } catch (e) {
      logger.error({ err: e.message }, 'Gagal mengambil daftar grup');
    }
    scheduler.start();
  });

  wa.on('closed', () => {
    // Scheduler dibiarkan hidup; siklus akan dilewati selama belum terhubung.
  });

  // Hot reload config
  watchConfig();
  onConfigChange(() => {
    cfg = getConfig();
    scheduler.reload();
  });

  await wa.start();

  // ---- Shutdown rapi ----
  let mati = false;
  const shutdown = async (sinyal) => {
    if (mati) return;
    mati = true;
    logger.info(`\n🛑 ${sinyal} diterima — menutup bot…`);
    scheduler.stop();
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    try {
      await wa.stop();
    } catch {
      /* noop */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (e) => {
    logger.error({ err: e?.message || String(e) }, '⚠️  unhandledRejection (bot tetap jalan)');
  });
  process.on('uncaughtException', (e) => {
    logger.error({ err: e?.message || String(e) }, '⚠️  uncaughtException (bot tetap jalan)');
  });
}

main().catch((e) => {
  logger.error({ err: e?.message || String(e) }, '💥 Bot gagal start');
  process.exit(1);
});
