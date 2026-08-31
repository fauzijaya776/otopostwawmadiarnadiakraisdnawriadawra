'use strict';

const { logger, banner } = require('./logger');
const { bacaState, tulisState } = require('./state');
const { simpanDanTampilkan, resolveTargets, targetsDariConfig } = require('./groups');
const {
  delay,
  withTimeout,
  randInt,
  nowParts,
  renderTemplate,
  dalamJadwalAktif,
  resolveMedia,
  ringkas,
} = require('./utils');

// Batas waktu supaya satu operasi macet tidak membekukan siklus.
const TIMEOUT_AMBIL_GRUP_MS = 60_000;
const TIMEOUT_KIRIM_MS = 120_000;

class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./whatsapp').WhatsAppClient} opts.wa
   * @param {() => object} opts.getConfig
   */
  constructor({ wa, getConfig }) {
    this.wa = wa;
    this.getConfig = getConfig;
    this.timer = null;
    this.berjalan = false;      // sedang mengirim batch
    this.aktif = false;         // scheduler hidup
    this.nextRunAt = null;
    this.state = bacaState();
    this.lastResult = null;
  }

  info() {
    const cfg = this.getConfig();
    return {
      aktif: this.aktif && cfg.jadwal.aktif,
      sedangMengirim: this.berjalan,
      intervalMenit: cfg.jadwal.intervalMenit,
      kirimBerikutnya: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      kirimBerikutnyaDalamDetik: this.nextRunAt
        ? Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000))
        : null,
      totalTerkirim: this.state.totalTerkirim,
      totalGagal: this.state.totalGagal,
      terakhirKirim: this.state.terakhirKirim,
      hasilTerakhir: this.lastResult,
    };
  }

  start() {
    const cfg = this.getConfig();
    this.aktif = true;
    if (!cfg.jadwal.aktif) {
      logger.warn('⏸️  jadwal.aktif = false — auto post tidak dijalankan.');
      return;
    }
    // start() dipanggil ulang setiap event "ready" (termasuk tiap reconnect).
    // Kalau siklus sudah dijadwalkan atau sedang berjalan, JANGAN dijadwalkan
    // ulang — kalau di-reset, timer kirim pertama (mis. 25 detik) mundur terus
    // tiap reconnect dan pengiriman tidak pernah benar-benar terjadi.
    if (this.timer || this.berjalan) {
      logger.info('▶️  Auto post sudah aktif — jadwal yang berjalan dipertahankan (tidak di-reset).');
      return;
    }
    const detikPertama = cfg.jadwal.kirimSaatStart
      ? cfg.jadwal.delaySebelumKirimPertamaDetik
      : cfg.jadwal.intervalMenit * 60;
    this.jadwalkan(detikPertama * 1000);
    logger.info(
      `🕒 Auto post aktif — interval ${cfg.jadwal.intervalMenit} menit, kiriman pertama ${detikPertama} detik lagi.`
    );
    this.laporkanTempo(cfg);
  }

  /**
   * Perkirakan lama satu siklus dari jumlah grup x jeda antar grup, lalu
   * peringatkan kalau siklus berisiko belum selesai saat siklus berikutnya
   * dijadwalkan (siklus yang tumpang tindih akan dilewati begitu saja).
   */
  laporkanTempo(cfg) {
    const n = cfg.grupTujuan.filter((g) => g.aktif).length;
    if (n < 2) return;

    const jedaMin = cfg.jadwal.jedaAntarGrupDetik;
    const jedaMax = jedaMin + cfg.jadwal.jitterDetik;
    const siklusMaxDetik = (n - 1) * jedaMax;
    const intervalDetik = cfg.jadwal.intervalMenit * 60;

    logger.info(
      `🐢 Jeda antar grup ${jedaMin}-${jedaMax} detik — ${n} grup ≈ ${Math.round(
        ((n - 1) * jedaMin) / 60
      )}-${Math.round(siklusMaxDetik / 60)} menit per siklus.`
    );

    if (siklusMaxDetik >= intervalDetik) {
      logger.warn(
        `⚠️  Satu siklus bisa memakan ${Math.round(siklusMaxDetik / 60)} menit, padahal interval cuma ${cfg.jadwal.intervalMenit} menit. ` +
          'Siklus berikutnya akan dilewati. Naikkan "intervalMenit" atau turunkan "jedaAntarGrupDetik".'
      );
    }
  }

  stop() {
    this.aktif = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Dipanggil kalau config.json berubah saat bot jalan. */
  reload() {
    if (!this.aktif) return;
    const cfg = this.getConfig();
    if (!cfg.jadwal.aktif) {
      logger.warn('⏸️  jadwal.aktif diubah jadi false — scheduler dihentikan.');
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.nextRunAt = null;
      return;
    }
    if (!this.timer) {
      this.jadwalkan(5000);
      logger.info('▶️  Scheduler dinyalakan ulang dari config.');
    }
  }

  jadwalkan(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = Date.now() + ms;
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    try {
      await this.jalankanSekali(false);
    } catch (e) {
      logger.error(
        { err: e.message, kode: e.statusCode || e?.output?.statusCode, stack: e.stack },
        '❌ Error saat siklus auto post'
      );
    } finally {
      if (this.aktif) {
        const cfg = this.getConfig();
        this.jadwalkan(cfg.jadwal.intervalMenit * 60 * 1000);
        logger.info(
          `⏭️  Kiriman berikutnya sekitar ${new Date(this.nextRunAt).toLocaleString('id-ID', {
            timeZone: cfg.bot.timezone,
          })}`
        );
      }
    }
  }

  /** Pilih pesan berikutnya sesuai mode "urut" / "acak". */
  pilihPesan(cfg) {
    const aktif = cfg.pesan.daftar.filter((m) => m.aktif && (m.teks || m.gambar));
    if (aktif.length === 0) return null;
    if (cfg.pesan.mode === 'acak') return aktif[randInt(0, aktif.length - 1)];
    const idx = this.state.indexPesan % aktif.length;
    this.state.indexPesan = (idx + 1) % aktif.length;
    return aktif[idx];
  }

  /**
   * Satu siklus pengiriman ke semua grup tujuan.
   * @param {boolean} manual true kalau dipicu lewat endpoint /send-now
   */
  async jalankanSekali(manual = false) {
    if (this.berjalan) {
      logger.warn('⏳ Siklus sebelumnya belum selesai — dilewati.');
      return { dilewati: true, alasan: 'siklus sebelumnya masih berjalan' };
    }
    const cfg = this.getConfig();

    if (!this.wa.connected) {
      logger.warn('📴 Bot belum terhubung ke WhatsApp — siklus dilewati.');
      return { dilewati: true, alasan: 'belum terhubung' };
    }

    if (!manual) {
      const cek = dalamJadwalAktif(cfg.jadwal, cfg.bot.timezone);
      if (!cek.ok) {
        logger.info(`😴 Siklus dilewati: ${cek.alasan}`);
        return { dilewati: true, alasan: cek.alasan };
      }
    }

    this.berjalan = true;
    const mulai = Date.now();

    try {
      const t = nowParts(cfg.bot.timezone);

      // 1) Segarkan daftar grup (sekaligus auto-isi ID dari nama). Kalau langkah
      //    ini gagal/timeout, siklus TIDAK dibatalkan — kita jatuh ke ID grup
      //    yang sudah tertulis di config.json supaya pesan tetap terkirim.
      let semuaGrup = null;
      try {
        semuaGrup = await withTimeout(
          this.wa.ambilSemuaGrup(),
          TIMEOUT_AMBIL_GRUP_MS,
          'ambil daftar grup timeout'
        );
      } catch (e) {
        logger.error(
          { err: e.message, kode: e.statusCode || e?.output?.statusCode },
          '⚠️  Gagal mengambil daftar grup — memakai ID grup dari config.json sebagai cadangan'
        );
      }

      let targets;
      if (semuaGrup) {
        simpanDanTampilkan(semuaGrup, { tulisFile: cfg.opsi.tulisGroupsJson, tampilkan: false });
        targets = resolveTargets(cfg, semuaGrup);
      } else {
        targets = targetsDariConfig(cfg);
      }

      if (targets.length === 0) {
        logger.warn('⚠️  Tidak ada grup tujuan yang valid. Cek "grupTujuan" di config.json.');
        return { dilewati: true, alasan: 'tidak ada grup tujuan valid' };
      }

      // 2) Pilih pesan
      const pesan = this.pilihPesan(cfg);
      if (!pesan) {
        logger.warn('⚠️  Tidak ada pesan aktif di config.json.');
        return { dilewati: true, alasan: 'tidak ada pesan aktif' };
      }

      // 3) Siapkan media sekali saja (dipakai ulang untuk semua grup)
      let media = null;
      if (pesan.gambar) {
        try {
          media = resolveMedia(pesan.gambar);
        } catch (e) {
          logger.error({ err: e.message }, '❌ Gambar gagal dimuat — pesan dikirim sebagai teks saja');
        }
      }

      banner(`AUTO POST • ${t.tanggal} ${t.jam} • ${targets.length} grup`);
      logger.info(`📝 Pesan: "${ringkas(pesan.teks, 70)}"${media ? ' + gambar' : ''}`);

      const detail = [];
      let sukses = 0;
      let gagal = 0;

      for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        const teks = renderTemplate(pesan.teks, {
          ...t,
          namaGrup: g.nama,
          idGrup: g.id,
          namaBot: cfg.bot.namaBot,
        });

        try {
          if (g.hanyaAdminBisaKirim && g.botAdmin === false) {
            throw new Error('grup hanya mengizinkan admin yang mengirim pesan');
          }
          const res = await withTimeout(
            this.wa.kirim(
              g.id,
              { teks, media },
              { tampilkanSedangMengetik: cfg.opsi.tampilkanSedangMengetik }
            ),
            TIMEOUT_KIRIM_MS,
            'kirim pesan timeout'
          );
          sukses++;
          detail.push({ grup: g.nama, id: g.id, status: 'ok', messageId: res?.key?.id || null });
          logger.info(`   ✅ [${i + 1}/${targets.length}] ${g.nama}`);
        } catch (e) {
          gagal++;
          detail.push({ grup: g.nama, id: g.id, status: 'gagal', error: e.message });
          logger.error(`   ❌ [${i + 1}/${targets.length}] ${g.nama} — ${e.message}`);
        }

        // Jeda antar grup: menahan laju supaya tidak terbaca sebagai spam.
        if (i < targets.length - 1) {
          const jeda =
            cfg.jadwal.jedaAntarGrupDetik * 1000 + randInt(0, cfg.jadwal.jitterDetik * 1000);
          if (jeda > 0) {
            logger.info(`   ⏳ jeda ${Math.round(jeda / 1000)} detik sebelum grup berikutnya…`);
            await delay(jeda);
          }
        }
      }

      this.state.totalTerkirim += sukses;
      this.state.totalGagal += gagal;
      this.state.terakhirKirim = new Date().toISOString();
      this.state.riwayat.push({
        waktu: this.state.terakhirKirim,
        pesan: ringkas(pesan.teks, 40),
        sukses,
        gagal,
      });
      tulisState(this.state);

      this.lastResult = {
        waktu: this.state.terakhirKirim,
        manual,
        totalGrup: targets.length,
        sukses,
        gagal,
        durasiDetik: Math.round((Date.now() - mulai) / 1000),
        detail,
      };

      logger.info(`🏁 Selesai: ${sukses} berhasil, ${gagal} gagal (${this.lastResult.durasiDetik}s)`);

      if (gagal === targets.length && cfg.opsi.hentikanJikaSemuaGrupGagal) {
        logger.error('🛑 Semua grup gagal & opsi.hentikanJikaSemuaGrupGagal = true — scheduler dihentikan.');
        this.stop();
      }

      return this.lastResult;
    } finally {
      this.berjalan = false;
    }
  }
}

module.exports = { Scheduler };
