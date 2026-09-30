'use strict';

/**
 * ================== AUTO INVITE ANGGOTA KE GRUP ==================
 *
 * Menambahkan banyak nomor ke grup WhatsApp dengan tempo yang mirip manusia,
 * supaya nomor bot tidak dianggap spam / diblokir.
 *
 * Alur per nomor:
 *   1. Cek nomor terdaftar di WhatsApp (onWhatsApp). Kalau tidak -> dilewati.
 *   2. Cek apakah sudah jadi anggota grup -> dilewati.
 *   3. Coba TAMBAH langsung (groupParticipantsUpdate 'add'). Bot HARUS admin.
 *        - status 200 -> berhasil masuk grup.
 *        - status 403 -> privasi ("siapa yang bisa menambahkan saya"). Tidak bisa
 *                        ditambah paksa. Sesuai config: kirim LINK undangan lewat
 *                        DM, kirim undangan natif, atau lewati.
 *        - status 409 -> sudah anggota.
 *        - status 408 -> baru keluar, belum boleh ditambah lagi (cooldown lama).
 *        - status 401 -> memblokir bot.
 *   4. Jeda acak (mirip manusia) sebelum nomor berikutnya + istirahat berkala.
 *
 * Pengaman anti-blokir:
 *   - Batas harian + jadwal pemanasan (naik bertahap untuk nomor baru).
 *   - Hanya bekerja di jam aktif (mis. 08:00-21:00).
 *   - Jeda acak antar nomor + "istirahat kopi" tiap sekian aksi.
 *   - Berhenti otomatis kalau kena rate-limit / gagal beruntun.
 *   - Progress disimpan -> aman di-stop/lanjut, tidak pernah mengundang 2x.
 *   - Kapasitas grup dihormati; kalau penuh, pindah ke grup berikutnya.
 *
 * PERINGATAN: mengundang nomor yang TIDAK pernah menghubungi kamu berisiko
 * membuat nomor bot dilaporkan & diblokir WhatsApp. Pakai untuk nomor yang
 * memang pelanggan/opt-in, mulai dari volume kecil, dan pantau kesehatan nomor.
 */

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');
const { logger, banner } = require('./logger');
const { WhatsAppClient } = require('./whatsapp');
const { delay, randInt, withTimeout, nowParts, hhmmToMinutes } = require('./utils');

const PROGRESS_PATH = path.join(PATHS.data, 'invite-progress.json');
const TIMEOUT_AKSI_MS = 60_000;

// ---------------------------------------------------------------------------
//  Baca / tulis progress
// ---------------------------------------------------------------------------

function progressKosong() {
  return {
    mulaiPada: new Date().toISOString(),
    // ringkasan per-tanggal: { "2026-09-22": jumlahAksiNyata }
    harian: {},
    // status per nomor: { "6281...": { status, grup, waktu } }
    nomor: {},
    // ringkasan
    total: { berhasil: 0, diundang: 0, dilewati: 0, gagal: 0 },
  };
}

function bacaProgress() {
  try {
    const j = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    return {
      ...progressKosong(),
      ...j,
      harian: j.harian || {},
      nomor: j.nomor || {},
      total: { berhasil: 0, diundang: 0, dilewati: 0, gagal: 0, ...(j.total || {}) },
    };
  } catch {
    return progressKosong();
  }
}

function tulisProgress(p) {
  try {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2) + '\n');
  } catch (e) {
    logger.warn({ err: e.message }, 'Gagal menyimpan invite-progress.json');
  }
}

// ---------------------------------------------------------------------------
//  Baca daftar nomor
// ---------------------------------------------------------------------------

/**
 * Baca file nomor (satu nomor per baris). Baris kosong & yang diawali # / //
 * diabaikan. Mendukung format +62..., 62..., 08... (0 di depan -> 62).
 */
function bacaNomor(file) {
  const abs = path.isAbsolute(file) ? file : path.join(PATHS.root, file);
  if (!fs.existsSync(abs)) {
    throw new Error(`File nomor tidak ditemukan: ${abs}`);
  }
  const isi = fs.readFileSync(abs, 'utf8');
  const keluar = [];
  const terlihat = new Set();

  for (const barisMentah of isi.split(/\r?\n/)) {
    const baris = barisMentah.trim();
    if (!baris || baris.startsWith('#') || baris.startsWith('//')) continue;

    let d = baris.replace(/[^0-9]/g, '');
    if (!d) continue;
    if (d.startsWith('0')) d = '62' + d.slice(1); // format lokal Indonesia
    // panjang nomor internasional yang masuk akal
    if (d.length < 8 || d.length > 20) continue;
    if (terlihat.has(d)) continue;
    terlihat.add(d);
    keluar.push(d);
  }
  return keluar;
}

// ---------------------------------------------------------------------------
//  Util jadwal
// ---------------------------------------------------------------------------

function tanggalKunci(timezone) {
  // "2026-09-22" pada timezone target
  const t = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Menit sampai jendela jam-aktif berikutnya dibuka (0 kalau sedang aktif). */
function menitSampaiAktif(jamAktif, timezone) {
  if (!jamAktif || !jamAktif.aktif) return 0;
  const t = nowParts(timezone);
  const start = hhmmToMinutes(jamAktif.mulai, 0);
  const end = hhmmToMinutes(jamAktif.selesai, 1439);
  const cur = t.minutesOfDay;
  const didalam = start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
  if (didalam) return 0;
  // hitung selisih ke "start" berikutnya
  let selisih = start - cur;
  if (selisih <= 0) selisih += 24 * 60;
  return selisih;
}

// ---------------------------------------------------------------------------
//  Inviter
// ---------------------------------------------------------------------------

class Inviter {
  /**
   * @param {object} opts
   * @param {import('./whatsapp').WhatsAppClient} opts.wa
   * @param {() => object} opts.getConfig
   * @param {boolean} [opts.dryRun] kalau true: hanya simulasi, tidak menambah/mengirim apa pun
   */
  constructor({ wa, getConfig, dryRun = false }) {
    this.wa = wa;
    this.getConfig = getConfig;
    this.dryRun = dryRun;
    this.berhenti = false;
    this.progress = bacaProgress();
    this.gagalBeruntun = 0;
    this.kodeUndanganCache = new Map(); // grupJid -> { kode, ts }
    this.anggotaCache = new Map(); // grupJid -> { set, jumlah, ts }
    this.jidCache = new Map(); // digitNomor -> JID resmi | null (hasil pra-cek terdaftar)
  }

  stop() {
    this.berhenti = true;
  }

  cfg() {
    return this.getConfig().undangan || {};
  }

  // ---- helper progress ----

  sudahDiproses(nomor) {
    const s = this.progress.nomor[nomor];
    if (!s) return false;
    // status yang dianggap "selesai, jangan ulang"
    return [
      'berhasil',
      'diundang',
      'sudah-anggota',
      'tidak-terdaftar',
      'diblokir',
      'privasi-dilewati', // FIX: mode "lewati" sekarang benar-benar ditandai selesai
    ].includes(s.status);
  }

  catat(nomor, status, extra = {}) {
    this.progress.nomor[nomor] = { status, waktu: new Date().toISOString(), ...extra };
  }

  hitungHarian() {
    const tz = this.getConfig().bot.timezone;
    const key = tanggalKunci(tz);
    return this.progress.harian[key] || 0;
  }

  tambahHarian(n = 1) {
    const tz = this.getConfig().bot.timezone;
    const key = tanggalKunci(tz);
    this.progress.harian[key] = (this.progress.harian[key] || 0) + n;
  }

  /** Batas aksi untuk HARI INI (memperhitungkan jadwal pemanasan). */
  batasHariIni() {
    const c = this.cfg();
    const batasNormal = Math.max(1, Number(c.batasHarian) || 40);
    const pemanasan = Array.isArray(c.pemanasan) ? c.pemanasan.map(Number).filter((x) => x > 0) : [];
    if (!pemanasan.length) return batasNormal;
    // hari keberapa sejak pertama kali jalan (berdasarkan jumlah tanggal yang tercatat)
    const jumlahHariJalan = Object.keys(this.progress.harian).length;
    const tz = this.getConfig().bot.timezone;
    const hariIniSudahAda = Object.prototype.hasOwnProperty.call(
      this.progress.harian,
      tanggalKunci(tz)
    );
    // indeks hari ke- (0-based): kalau hari ini belum tercatat, dia hari berikutnya
    const idx = hariIniSudahAda ? jumlahHariJalan - 1 : jumlahHariJalan;
    const capPemanasan = idx < pemanasan.length ? pemanasan[idx] : batasNormal;
    return Math.min(batasNormal, capPemanasan);
  }

  // ---- helper grup ----

  async segarkanAnggota(grupJid, paksa = false) {
    const hit = this.anggotaCache.get(grupJid);
    if (!paksa && hit && Date.now() - hit.ts < 90_000) return hit;
    const meta = await withTimeout(
      this.wa.metadataGrup(grupJid, true),
      TIMEOUT_AKSI_MS,
      'ambil metadata grup timeout'
    );
    const potong = (v) => (v || '').toString().split('@')[0].split(':')[0];
    const set = new Set();
    for (const p of meta.participants || []) {
      if (p.id) set.add(potong(p.id));
      if (p.jid) set.add(potong(p.jid));
    }
    const data = {
      set,
      jumlah: (meta.participants || []).length,
      subject: meta.subject || '',
      botAdmin: this.cekBotAdmin(meta),
      ts: Date.now(),
    };
    this.anggotaCache.set(grupJid, data);
    return data;
  }

  cekBotAdmin(meta) {
    const potong = (v) => (v || '').toString().split('@')[0].split(':')[0];
    const idSaya = new Set(
      [potong(this.wa.sock?.user?.id), potong(this.wa.sock?.user?.lid)].filter(Boolean)
    );
    const saya = (meta.participants || []).find(
      (p) => idSaya.has(potong(p.id)) || idSaya.has(potong(p.lid)) || idSaya.has(potong(p.jid))
    );
    if (!saya) return null;
    return saya.admin === 'admin' || saya.admin === 'superadmin';
  }

  async kodeUndangan(grupJid) {
    const hit = this.kodeUndanganCache.get(grupJid);
    if (hit && Date.now() - hit.ts < 30 * 60_000) return hit.kode;
    const kode = await withTimeout(
      this.wa.kodeUndanganGrup(grupJid),
      TIMEOUT_AKSI_MS,
      'ambil kode undangan timeout'
    );
    this.kodeUndanganCache.set(grupJid, { kode, ts: Date.now() });
    return kode;
  }

  /**
   * Pilih grup tujuan pertama yang belum penuh. Mengembalikan { jid, sisa, info }
   * atau null kalau semua penuh / tidak ada grup valid.
   */
  async pilihGrup() {
    const c = this.cfg();
    const daftar = (Array.isArray(c.grupTujuan) ? c.grupTujuan : [])
      .map((g) => (typeof g === 'string' ? g : g?.id))
      .map((s) => (s || '').toString().trim())
      .filter(Boolean)
      .map((s) => (s.endsWith('@g.us') ? s : `${s.replace(/[^0-9-]/g, '')}@g.us`));

    const batas = Math.max(2, Number(c.batasAnggotaPerGrup) || 1000);

    for (const jid of daftar) {
      let info;
      try {
        info = await this.segarkanAnggota(jid, true);
      } catch (e) {
        logger.warn({ jid, err: e.message }, '⚠️  Gagal ambil info grup — dilewati');
        continue;
      }
      if (info.botAdmin === false) {
        logger.warn(`⚠️  Bot BUKAN admin di grup ${info.subject || jid} — tidak bisa mengundang. Dilewati.`);
        continue;
      }
      if (info.jumlah >= batas) {
        logger.info(`ℹ️  Grup ${info.subject || jid} sudah penuh (${info.jumlah}/${batas}) — lanjut ke grup berikutnya.`);
        continue;
      }
      return { jid, sisa: batas - info.jumlah, info };
    }
    return null;
  }

  // ---- pra-cek terdaftar (massal) ----

  /**
   * Cek registrasi SEMUA nomor sekali di depan, dalam bongkahan besar. Ini
   * memangkas satu panggilan jaringan per nomor saat loop undang -> jauh lebih
   * cepat. Hasil disimpan di jidCache (nomor -> JID | null). Zero risiko blokir:
   * ini cuma pencarian kontak, bukan mengirim/menambah apa pun.
   */
  async pracek(nomors) {
    const c = this.cfg();
    if (c.pracekTerdaftar === false) return;
    const ukuran = Math.max(20, Math.min(400, Number(c.ukuranPracek) || 200));
    let dicek = 0;
    let terdaftar = 0;
    logger.info(`🔎 Pra-cek registrasi ${nomors.length} nomor (bongkahan ${ukuran})…`);
    for (let i = 0; i < nomors.length; i += ukuran) {
      if (this.berhenti) break;
      const bagian = nomors.slice(i, i + ukuran);
      let peta;
      try {
        peta = await withTimeout(
          this.wa.cekTerdaftarBanyak(bagian),
          TIMEOUT_AKSI_MS * 2,
          'pra-cek massal timeout'
        );
      } catch (e) {
        logger.debug({ err: e.message }, 'pra-cek bongkahan gagal — dilewati (cek satuan nanti)');
        continue;
      }
      for (const [d, jid] of peta) {
        this.jidCache.set(d, jid);
        dicek++;
        if (jid) terdaftar++;
      }
      // jeda kecil supaya tidak terlihat membanjiri server dengan query
      await delay(randInt(300, 800));
    }
    logger.info(`   → ${dicek} nomor tercek, ${terdaftar} aktif di WhatsApp, ${dicek - terdaftar} tidak terdaftar.\n`);
  }

  /**
   * Ambil JID resmi sebuah nomor. Pakai hasil pra-cek kalau ada; kalau nomor
   * belum pernah dicek (mis. pra-cek dimatikan / bongkahannya gagal), cek satuan.
   * @returns {Promise<string|null|undefined>} JID | null(tidak terdaftar) | undefined(tak yakin)
   */
  async resolveJid(nomor) {
    const d = String(nomor).replace(/[^0-9]/g, '');
    if (this.jidCache.has(d)) return this.jidCache.get(d);
    const jid = await withTimeout(this.wa.cekTerdaftar(nomor), TIMEOUT_AKSI_MS, 'cek nomor timeout');
    if (jid !== undefined) this.jidCache.set(d, jid); // simpan hasil pasti saja
    return jid;
  }

  // ---- proses sekelompok nomor sekaligus ----

  /**
   * Proses satu bongkahan nomor. Nomor yang lolos pra-syarat (terdaftar & belum
   * anggota) ditambahkan dalam SATU panggilan groupParticipantsUpdate (lebih
   * cepat). Nomor 403 (privasi) ditangani per-nomor (kirim link undangan).
   * @returns {Promise<Array<{nomor:string, hasil:string}>>}
   */
  async prosesBatch(nomors, grup) {
    const c = this.cfg();
    const potong = (v) => (v || '').toString().split('@')[0].split(':')[0];
    const outcomes = [];
    const perluTambah = []; // { nomor, jid, nomorJid }

    // --- saring: sudah anggota / tidak terdaftar / tak yakin ---
    for (const nomor of nomors) {
      if (grup.info.set.has(nomor)) {
        this.catat(nomor, 'sudah-anggota', { grup: grup.jid });
        this.progress.total.dilewati++;
        logger.info(`   • ${nomor} sudah jadi anggota — dilewati`);
        outcomes.push({ nomor, hasil: 'sudah-anggota' });
        continue;
      }
      let jid;
      try {
        jid = await this.resolveJid(nomor);
      } catch (e) {
        const kode = e?.output?.statusCode || e?.status;
        if (kode === 429 || /rate|overlimit|too many/i.test(e.message || '')) {
          throw Object.assign(new Error('rate-limit'), { rateLimit: true });
        }
        logger.warn(`   ? ${nomor} gagal dicek — akan dicoba lagi nanti`);
        outcomes.push({ nomor, hasil: 'tak-yakin' });
        continue;
      }
      if (jid === null) {
        this.catat(nomor, 'tidak-terdaftar');
        this.progress.total.dilewati++;
        logger.info(`   ⤫ ${nomor} tidak terdaftar di WhatsApp — dilewati`);
        outcomes.push({ nomor, hasil: 'tidak-terdaftar' });
        continue;
      }
      if (jid === undefined) {
        // FIX: error jaringan = "tak-yakin", TIDAK dihitung sebagai gagal beruntun
        logger.warn(`   ? ${nomor} gagal dicek — akan dicoba lagi nanti`);
        outcomes.push({ nomor, hasil: 'tak-yakin' });
        continue;
      }
      const nomorJid = potong(jid);
      if (grup.info.set.has(nomorJid)) {
        this.catat(nomor, 'sudah-anggota', { grup: grup.jid });
        this.progress.total.dilewati++;
        logger.info(`   • ${nomor} sudah jadi anggota — dilewati`);
        outcomes.push({ nomor, hasil: 'sudah-anggota' });
        continue;
      }
      if (this.dryRun) {
        logger.info(`   [dry-run] akan mencoba menambahkan ${nomor}`);
        this.catat(nomor, 'dry-run', { grup: grup.jid });
        outcomes.push({ nomor, hasil: 'berhasil' });
        continue;
      }
      perluTambah.push({ nomor, jid, nomorJid });
    }

    if (!perluTambah.length) return outcomes;

    // --- tambah semua sekaligus ---
    let hasilPeta;
    try {
      hasilPeta = await withTimeout(
        this.wa.tambahBanyakKeGrup(grup.jid, perluTambah.map((x) => x.jid)),
        TIMEOUT_AKSI_MS,
        'tambah anggota timeout'
      );
    } catch (e) {
      const kode = e?.output?.statusCode || e?.status;
      if (kode === 429 || /rate|overlimit|too many/i.test(e.message || '')) {
        throw Object.assign(new Error('rate-limit'), { rateLimit: true });
      }
      logger.error(`   ❌ Batch gagal ditambah — ${e.message}`);
      for (const x of perluTambah) {
        this.catat(x.nomor, 'gagal', { grup: grup.jid, error: e.message });
        this.progress.total.gagal++;
        outcomes.push({ nomor: x.nomor, hasil: 'gagal' });
      }
      return outcomes;
    }

    for (const x of perluTambah) {
      const st = (hasilPeta.get(x.jid) || { status: '000' }).status;

      if (st === '200') {
        this.catat(x.nomor, 'berhasil', { grup: grup.jid });
        this.progress.total.berhasil++;
        grup.info.set.add(x.nomorJid);
        grup.info.jumlah++;
        grup.sisa--;
        logger.info(`   ✅ ${x.nomor} ditambahkan ke grup`);
        outcomes.push({ nomor: x.nomor, hasil: 'berhasil' });
      } else if (st === '409') {
        this.catat(x.nomor, 'sudah-anggota', { grup: grup.jid });
        this.progress.total.dilewati++;
        grup.info.set.add(x.nomorJid);
        logger.info(`   • ${x.nomor} sudah jadi anggota — dilewati`);
        outcomes.push({ nomor: x.nomor, hasil: 'sudah-anggota' });
      } else if (st === '408') {
        this.catat(x.nomor, 'baru-keluar', { grup: grup.jid });
        this.progress.total.dilewati++;
        logger.info(`   • ${x.nomor} baru keluar grup — ditunda`);
        outcomes.push({ nomor: x.nomor, hasil: 'sudah-anggota' });
      } else if (st === '401') {
        this.catat(x.nomor, 'diblokir', { grup: grup.jid });
        this.progress.total.dilewati++;
        logger.info(`   • ${x.nomor} memblokir bot — dilewati`);
        outcomes.push({ nomor: x.nomor, hasil: 'diblokir' });
      } else if (st === '403') {
        const mode = c.modeGagalPrivasi || 'kirimLink';
        if (mode === 'lewati') {
          this.catat(x.nomor, 'privasi-dilewati', { grup: grup.jid });
          this.progress.total.dilewati++;
          logger.info(`   ~ ${x.nomor} privasi (tidak bisa ditambah) — dilewati`);
          outcomes.push({ nomor: x.nomor, hasil: 'privasi-dilewati' });
          continue;
        }
        const terkirim = await this.kirimUndangan(x.jid, x.nomor, grup, mode);
        if (terkirim) {
          this.catat(x.nomor, 'diundang', { grup: grup.jid, cara: mode });
          this.progress.total.diundang++;
          logger.info(`   📨 ${x.nomor} privasi — link undangan dikirim`);
          outcomes.push({ nomor: x.nomor, hasil: 'diundang' });
        } else {
          this.catat(x.nomor, 'gagal', { grup: grup.jid, error: 'gagal kirim undangan' });
          this.progress.total.gagal++;
          outcomes.push({ nomor: x.nomor, hasil: 'gagal' });
        }
      } else {
        logger.warn(`   ❔ ${x.nomor} status tak dikenal (${st}) — dicatat sebagai gagal`);
        this.catat(x.nomor, 'gagal', { grup: grup.jid, error: `status ${st}` });
        this.progress.total.gagal++;
        outcomes.push({ nomor: x.nomor, hasil: 'gagal' });
      }
    }
    return outcomes;
  }

  async kirimUndangan(jid, nomor, grup, mode) {
    const c = this.cfg();
    let kode;
    try {
      kode = await this.kodeUndangan(grup.jid);
    } catch (e) {
      logger.error({ err: e.message }, 'Gagal ambil kode undangan grup');
      return false;
    }
    const link = `https://chat.whatsapp.com/${kode}`;
    const teks = (c.pesanUndangan || 'Kamu diundang bergabung ke grup kami:\n{{link}}')
      .replace(/\{\{\s*link\s*\}\}/g, link)
      .replace(/\{\{\s*namaGrup\s*\}\}/g, grup.info.subject || '');

    if (mode === 'undanganNatif') {
      try {
        await withTimeout(
          this.wa.kirimUndanganNatif(jid, {
            grupJid: grup.jid,
            nama: grup.info.subject,
            kode,
            caption: teks,
          }),
          TIMEOUT_AKSI_MS,
          'kirim undangan natif timeout'
        );
        return true;
      } catch (e) {
        logger.warn({ err: e.message }, 'Undangan natif gagal — jatuh ke link teks');
      }
    }

    try {
      await withTimeout(
        this.wa.kirimDM(jid, teks, { tampilkanSedangMengetik: true }),
        TIMEOUT_AKSI_MS,
        'kirim DM undangan timeout'
      );
      return true;
    } catch (e) {
      const kode2 = e?.output?.statusCode || e?.status;
      if (kode2 === 429 || /rate|overlimit/i.test(e.message || '')) {
        throw Object.assign(new Error('rate-limit'), { rateLimit: true });
      }
      logger.error({ err: e.message }, 'Gagal kirim DM undangan');
      return false;
    }
  }

  // ---- loop utama ----

  async jalankan() {
    const c = this.cfg();
    if (c.aktif === false) {
      logger.warn('⏸️  undangan.aktif = false di config.json — auto invite tidak dijalankan.');
      return;
    }

    let nomorSemua;
    try {
      nomorSemua = bacaNomor(c.fileNomor || 'data/nomor.txt');
    } catch (e) {
      logger.error({ err: e.message }, '❌ Tidak bisa membaca daftar nomor');
      return;
    }

    // acak urutan supaya polanya tidak berurutan (lebih mirip manusia)
    if (c.acakUrutan !== false) {
      for (let i = nomorSemua.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nomorSemua[i], nomorSemua[j]] = [nomorSemua[j], nomorSemua[i]];
      }
    }

    const belum = nomorSemua.filter((n) => !this.sudahDiproses(n));

    banner('AUTO INVITE ANGGOTA KE GRUP');
    logger.info(`📋 Total nomor       : ${nomorSemua.length}`);
    logger.info(`✔️  Sudah diproses    : ${nomorSemua.length - belum.length}`);
    logger.info(`🎯 Sisa akan diproses: ${belum.length}`);
    logger.info(`📆 Batas hari ini    : ${this.batasHariIni()} (sudah ${this.hitungHarian()})`);
    if (this.dryRun) logger.warn('🧪 MODE DRY-RUN: tidak ada yang benar-benar ditambah/dikirim.');
    logger.info('');

    if (belum.length === 0) {
      logger.info('🎉 Semua nomor sudah pernah diproses. Tidak ada yang perlu diundang.');
      this.ringkasan();
      return;
    }

    // pra-cek registrasi semua nomor sekaligus (cepat, tanpa risiko blokir)
    await this.pracek(belum);
    if (this.berhenti) {
      tulisProgress(this.progress);
      this.ringkasan();
      return;
    }

    // pilih grup tujuan
    let grup = await this.pilihGrup();
    if (!grup) {
      logger.error('❌ Tidak ada grup tujuan yang bisa dipakai (bot bukan admin / semua penuh / ID salah). Cek "undangan.grupTujuan".');
      return;
    }
    logger.info(`👥 Grup aktif: ${grup.info.subject || grup.jid} — sisa slot ${grup.sisa}\n`);

    const jeda = c.jeda || {};
    const antar = Math.max(5, Number(jeda.antarNomorDetik) || 25);
    const jitter = Math.max(0, Number(jeda.jitterDetik) || 20);
    const istirahatSetiap = Math.max(0, Number(jeda.istirahatSetiap) || 25);
    const istirahatMenit = Math.max(0, Number(jeda.istirahatMenit) || 5);
    const istirahatJitter = Math.max(0, Number(jeda.istirahatJitterMenit) || 5);
    const maksGagal = Math.max(1, Number(c.maksGagalBeruntun) || 8);
    // berapa nomor ditambah dalam SATU panggilan. 1 = paling aman; 2-3 = lebih
    // cepat & masih wajar (apalagi kalau nomor tujuan sudah jadi kontak bot).
    const perBatch = Math.max(1, Math.min(5, Number(c.tambahSekaligus) || 1));
    logger.info(`⚙️  Tempo: jeda ~${antar}-${antar + jitter}s, tambah ${perBatch}/aksi, istirahat tiap ${istirahatSetiap} aksi.\n`);

    let sejakIstirahat = 0;
    let i = 0;

    while (i < belum.length) {
      if (this.berhenti) {
        logger.warn('🛑 Dihentikan pengguna.');
        break;
      }

      // --- jam aktif --- (dilewati saat dry-run)
      if (!this.dryRun) {
        const tungguMenit = menitSampaiAktif(c.jamAktif, this.getConfig().bot.timezone);
        if (tungguMenit > 0) {
          logger.info(`😴 Di luar jam aktif — tidur ${tungguMenit} menit sampai jendela berikutnya.`);
          tulisProgress(this.progress);
          const ok = await this.tidur(tungguMenit * 60_000);
          if (!ok) break;
        }
      }

      // --- batas harian --- (dilewati saat dry-run)
      let sisaKuota = this.batasHariIni() - this.hitungHarian();
      if (!this.dryRun && sisaKuota <= 0) {
        const tz = this.getConfig().bot.timezone;
        let tungguKeAktif = menitSampaiAktif(c.jamAktif, tz);
        if (tungguKeAktif === 0) {
          const t = nowParts(tz);
          tungguKeAktif = 24 * 60 - t.minutesOfDay + hhmmToMinutes((c.jamAktif || {}).mulai, 0);
        }
        logger.info(
          `📆 Batas harian (${this.batasHariIni()}) tercapai. Tidur ${Math.round(
            tungguKeAktif / 60
          )} jam lalu lanjut otomatis…`
        );
        tulisProgress(this.progress);
        const ok = await this.tidur(tungguKeAktif * 60_000);
        if (!ok) break;
        continue; // hitung ulang batas untuk hari baru
      }
      if (this.dryRun) sisaKuota = perBatch; // dry-run: jangan dibatasi kuota

      // --- pastikan grup belum penuh ---
      if (grup.sisa <= 0) {
        logger.info('👥 Grup penuh — mencari grup berikutnya…');
        grup = await this.pilihGrup();
        if (!grup) {
          logger.warn('🏁 Semua grup tujuan sudah penuh / tidak tersedia. Selesai.');
          break;
        }
        logger.info(`👥 Pindah ke grup: ${grup.info.subject || grup.jid} — sisa slot ${grup.sisa}\n`);
      }

      // --- ambil satu bongkahan nomor ---
      const ukuran = Math.max(1, Math.min(perBatch, sisaKuota, grup.sisa, belum.length - i));
      const chunk = belum.slice(i, i + ukuran);
      i += chunk.length;

      logger.info(`[${Math.min(i, belum.length)}/${belum.length}] memproses ${chunk.length} nomor…`);

      let outcomes;
      try {
        outcomes = await this.prosesBatch(chunk, grup);
      } catch (e) {
        if (e.rateLimit) {
          logger.error('🚫 Kena rate-limit WhatsApp! Berhenti untuk melindungi nomor.');
          if (c.berhentiSaatKenaLimit !== false) {
            tulisProgress(this.progress);
            break;
          }
          await this.tidur(30 * 60_000);
          continue;
        }
        logger.error({ err: e.message }, 'Error tak terduga memproses bongkahan');
        outcomes = chunk.map((n) => ({ nomor: n, hasil: 'gagal' }));
      }

      // --- hitung hasil bongkahan ---
      let adaAksi = false;
      for (const o of outcomes) {
        if (o.hasil === 'berhasil' || o.hasil === 'diundang') {
          if (!this.dryRun) this.tambahHarian(1);
          this.gagalBeruntun = 0;
          sejakIstirahat++;
          adaAksi = true;
        } else if (o.hasil === 'gagal') {
          this.gagalBeruntun++;
        } else if (o.hasil !== 'tak-yakin') {
          // sudah-anggota / tidak-terdaftar / diblokir / privasi-dilewati:
          // tidak membakar kuota & bukan gagal. ('tak-yakin' dibiarkan: tidak
          // menaikkan gagal beruntun, tidak ditandai selesai -> dicoba lagi.)
          this.gagalBeruntun = 0;
        }
      }

      tulisProgress(this.progress);

      if (this.gagalBeruntun >= maksGagal) {
        logger.error(
          `🚫 ${this.gagalBeruntun} kegagalan beruntun — berhenti untuk keamanan nomor. Cek koneksi / status admin / kesehatan nomor.`
        );
        break;
      }

      // bongkahan terakhir tidak perlu jeda
      if (i >= belum.length) break;

      // dry-run: tanpa jeda panjang, langsung lanjut
      if (this.dryRun) continue;

      // Bongkahan yang isinya cuma "sudah anggota / tidak terdaftar" tidak
      // menyentuh server -> lewati jeda panjang supaya sampah cepat terlewati.
      if (!adaAksi) continue;

      // --- istirahat berkala ("coffee break") ---
      if (istirahatSetiap > 0 && sejakIstirahat >= istirahatSetiap) {
        sejakIstirahat = 0;
        const menit = istirahatMenit + Math.random() * istirahatJitter;
        logger.info(`☕ Istirahat ${menit.toFixed(1)} menit supaya tempo terlihat wajar…`);
        const ok = await this.tidur(menit * 60_000);
        if (!ok) break;
        continue;
      }

      // --- jeda antar bongkahan ---
      const ms = antar * 1000 + randInt(0, jitter * 1000);
      logger.info(`   ⏳ jeda ${(ms / 1000).toFixed(0)} detik…`);
      const ok = await this.tidur(ms);
      if (!ok) break;
    }

    tulisProgress(this.progress);
    this.ringkasan();
  }

  /** Tidur yang bisa diinterupsi oleh stop(). @returns false kalau di-stop. */
  async tidur(ms) {
    const langkah = 1000;
    let sisa = ms;
    while (sisa > 0) {
      if (this.berhenti) return false;
      await delay(Math.min(langkah, sisa));
      sisa -= langkah;
    }
    return !this.berhenti;
  }

  ringkasan() {
    const t = this.progress.total;
    banner('RINGKASAN AUTO INVITE');
    logger.info(`✅ Ditambahkan langsung : ${t.berhasil}`);
    logger.info(`📨 Diundang via link    : ${t.diundang}`);
    logger.info(`↷  Dilewati             : ${t.dilewati}`);
    logger.info(`❌ Gagal                : ${t.gagal}`);
    logger.info(`💾 Progress tersimpan   : ${PROGRESS_PATH}`);
    logger.info('   (jalankan lagi kapan saja untuk melanjutkan sisa nomor)');
  }
}

module.exports = { Inviter, bacaNomor, PROGRESS_PATH };
