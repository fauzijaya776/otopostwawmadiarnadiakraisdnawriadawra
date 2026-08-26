'use strict';

const express = require('express');
const { logger } = require('./logger');
const { getTerakhir } = require('./groups');
const { exportBase64, punyaSesi } = require('./session');

/**
 * HTTP server kecil:
 *  - dibutuhkan Render (Web Service wajib membuka PORT)
 *  - sekaligus panel status sederhana + endpoint kontrol
 */
function buatServer({ wa, scheduler, getConfig }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const TOKEN = (process.env.ADMIN_TOKEN || '').trim();
  const butuhToken = (req, res, next) => {
    if (!TOKEN) return next();
    if (req.get('x-admin-token') === TOKEN || req.query.token === TOKEN) return next();
    return res.status(401).json({ ok: false, error: 'token tidak valid (header x-admin-token)' });
  };

  // Health check untuk Render
  app.get('/health', (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

  app.get('/', (req, res) => {
    const cfg = getConfig();
    const info = wa.info();
    const sch = scheduler.info();
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>WA AutoPost Bot</title>
<style>
 body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0f1216;color:#e6e9ef;margin:0;padding:32px}
 .card{max-width:720px;margin:0 auto;background:#161b22;border:1px solid #262d36;border-radius:14px;padding:24px}
 h1{margin:0 0 4px;font-size:20px} .sub{color:#8b95a5;font-size:13px;margin-bottom:20px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 td{padding:8px 0;border-bottom:1px solid #232a33} td:first-child{color:#8b95a5;width:45%}
 .ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}
</style>
<div class="card">
<h1>🤖 ${cfg.bot.namaBot}</h1>
<div class="sub">Bot auto post WhatsApp — status live</div>
<table>
<tr><td>Koneksi WhatsApp</td><td class="${info.terhubung ? 'ok' : 'bad'}">${info.terhubung ? 'TERHUBUNG' : 'TERPUTUS'} (${info.status})</td></tr>
<tr><td>Nomor bot</td><td>${info.nomor ? '+' + info.nomor : '-'}</td></tr>
<tr><td>Pairing code</td><td class="warn">${info.pairingCode || '-'}</td></tr>
<tr><td>Auto post</td><td>${sch.aktif ? 'AKTIF' : 'NONAKTIF'} — tiap ${sch.intervalMenit} menit</td></tr>
<tr><td>Kiriman berikutnya</td><td>${sch.kirimBerikutnyaDalamDetik != null ? sch.kirimBerikutnyaDalamDetik + ' detik lagi' : '-'}</td></tr>
<tr><td>Total terkirim / gagal</td><td>${sch.totalTerkirim} / ${sch.totalGagal}</td></tr>
<tr><td>Grup tujuan</td><td>${cfg.grupTujuan.filter((g) => g.aktif).length} aktif</td></tr>
<tr><td>Uptime</td><td>${Math.round(process.uptime())} detik</td></tr>
</table>
<p class="sub" style="margin-top:18px">Endpoint: <code>/health</code> · <code>/status</code> · <code>/groups</code> · <code>/pairing</code> · <code>/send-now</code> (POST) · <code>/session</code></p>
</div>`);
  });

  app.get('/status', (req, res) => {
    const cfg = getConfig();
    res.json({
      ok: true,
      whatsapp: wa.info(),
      scheduler: scheduler.info(),
      config: {
        namaBot: cfg.bot.namaBot,
        timezone: cfg.bot.timezone,
        intervalMenit: cfg.jadwal.intervalMenit,
        grupAktif: cfg.grupTujuan.filter((g) => g.aktif).length,
        pesanAktif: cfg.pesan.daftar.filter((m) => m.aktif).length,
        modePesan: cfg.pesan.mode,
      },
      sesiTersimpan: punyaSesi(),
    });
  });

  app.get('/pairing', (req, res) => {
    const info = wa.info();
    res.json({
      ok: true,
      terhubung: info.terhubung,
      pairingCode: info.pairingCode,
      petunjuk: info.pairingCode
        ? 'Buka WhatsApp di HP > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon, lalu masukkan kode ini.'
        : info.terhubung
          ? 'Bot sudah terhubung, tidak perlu pairing.'
          : 'Kode belum tersedia. Tunggu beberapa detik lalu refresh halaman ini.',
    });
  });

  app.get('/groups', butuhToken, async (req, res) => {
    try {
      if (req.query.refresh === '1' && wa.connected) {
        const grup = await wa.ambilSemuaGrup();
        const { simpanDanTampilkan } = require('./groups');
        simpanDanTampilkan(grup, { tulisFile: true, tampilkan: false });
      }
      res.json({ ok: true, ...getTerakhir() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/send-now', butuhToken, async (req, res) => {
    try {
      const hasil = await scheduler.jalankanSekali(true);
      res.json({ ok: true, hasil });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/session', butuhToken, (req, res) => {
    try {
      res.type('text/plain').send(exportBase64());
    } catch (e) {
      res.status(400).type('text/plain').send('Gagal: ' + e.message);
    }
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`🌐 HTTP server jalan di port ${port}`);
  });

  return { app, server };
}

/**
 * Render free tier menidurkan service setelah ~15 menit tanpa trafik.
 * Ping diri sendiri tiap 10 menit supaya interval auto post tetap jalan.
 */
function mulaiKeepAlive() {
  const aktif = String(process.env.KEEPALIVE || 'true').toLowerCase() !== 'false';
  const url = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!aktif || !url) return null;

  const ping = async () => {
    try {
      const r = await fetch(`${url}/health`, { headers: { 'user-agent': 'wa-bot-keepalive' } });
      logger.debug(`💓 keepalive ${r.status}`);
    } catch (e) {
      logger.debug(`keepalive gagal: ${e.message}`);
    }
  };
  const t = setInterval(ping, 10 * 60 * 1000);
  logger.info(`💓 Keepalive aktif -> ${url}/health tiap 10 menit`);
  setTimeout(ping, 30_000);
  return t;
}

module.exports = { buatServer, mulaiKeepAlive };
