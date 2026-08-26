'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const isTTY = process.stdout.isTTY;

/**
 * Logger utama aplikasi.
 * Di terminal (cmd) tampil berwarna & rapi, di Render tampil sebagai JSON biasa.
 */
const logger = pino(
  { level },
  isTTY
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      })
    : undefined
);

/**
 * Logger khusus Baileys. Default 'error': cukup senyap supaya log tidak banjir,
 * tapi kegagalan internal (mis. saat menyelesaikan pairing) tetap terlihat —
 * dulu 'silent' membuat error hilang tanpa jejak.
 * Untuk menelusuri masalah: BAILEYS_LOG_LEVEL=debug npm start
 */
const waLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });

/** Cetak baris pemisah + judul, biar mudah dibaca di cmd. */
function banner(title) {
  const line = '='.repeat(Math.max(46, title.length + 8));
  console.log('\n' + line);
  console.log('  ' + title);
  console.log(line + '\n');
}

module.exports = { logger, waLogger, banner };
