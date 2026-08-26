'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { ambilBaileys, baileysSiap } = require('./baileys');
const { PATHS } = require('./paths');
const { logger, waLogger, banner } = require('./logger');
const { delay, randInt } = require('./utils');
const sesi = require('./session');

// Baileys dimuat lewat ./baileys.js (mendukung build CommonJS maupun ESM).
const MAX_BACKOFF_MS = 60_000;

// Dipakai kalau fetchLatestBaileysVersion() gagal (misal jaringan Render lagi
// bermasalah). JANGAN dibiarkan undefined: versi bawaan Baileys 6.7.18 sudah
// terlalu tua dan ditolak server WhatsApp dengan statusCode 405.
const VERSI_CADANGAN = [2, 3000, 1043857760];

// WhatsApp membatasi berapa sering satu nomor boleh minta pairing code. Kalau
// dilanggar, server membalas <error code="429" text="rate-overlimit"/> dan
// SEMUA percobaan berikutnya gagal — termasuk kode yang diketik dengan benar.
// Terus mencoba justru memperpanjang blokirnya, jadi bot wajib berhenti dulu.
const RATE_COOLDOWN_MS = 60 * 60 * 1000; // 1 jam
const MAKS_PAIRING_PER_JAM = 4;

function bacaPairingState() {
  try {
    const j = JSON.parse(fs.readFileSync(PATHS.pairingState, 'utf8'));
    return { permintaan: Array.isArray(j.permintaan) ? j.permintaan : [], cooldownSampai: j.cooldownSampai || 0 };
  } catch {
    return { permintaan: [], cooldownSampai: 0 };
  }
}

function tulisPairingState(st) {
  try {
    fs.writeFileSync(PATHS.pairingState, JSON.stringify(st, null, 2));
  } catch {
    /* noop */
  }
}

function menitLagi(ms) {
  return Math.max(1, Math.ceil(ms / 60000));
}

/** Ambil kode status dari error Boom milik Baileys. */
function statusCode(err) {
  return err?.output?.statusCode ?? err?.output?.payload?.statusCode ?? err?.status ?? 0;
}

class WhatsAppClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig  fungsi yang mengembalikan config terbaru
   */
  constructor({ getConfig }) {
    super();
    this.getConfig = getConfig;
    this.sock = null;
    this.siap = false;
    this.pairingCode = null;
    this.percobaan = 0;
    this.sedangConnect = false;
    this.berhenti = false;
    this.qrDicetak = false;
    this.pairingDiminta = false;
    this.pairingGagal = 0;
    this.connectPertama = true;
    this.pairingSukses = false;
    this.groupCache = new Map(); // jid -> { data, ts }
    this.statusTeks = 'belum terhubung';
  }

  get connected() {
    return this.siap && !!this.sock?.user;
  }

  info() {
    return {
      terhubung: this.connected,
      status: this.statusTeks,
      nomor: this.sock?.user?.id ? this.sock.user.id.split(':')[0] : null,
      nama: this.sock?.user?.name || null,
      pairingCode: this.pairingCode,
      percobaanReconnect: this.percobaan,
    };
  }

  async start() {
    this.berhenti = false;
    // Dimuat di awal supaya kegagalan library langsung ketahuan, bukan
    // terjebak di loop reconnect.
    const b = await ambilBaileys();
    logger.info(`📚 Library WhatsApp: ${b.__paket}`);
    sesi.pulihkanDariEnv();
    await this.connect();
  }

  async stop() {
    this.berhenti = true;
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* noop */
    }
  }

  async connect() {
    if (this.sedangConnect || this.berhenti) return;
    this.sedangConnect = true;

    try {
      const cfg = this.getConfig();
      const {
        makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
        Browsers,
      } = await ambilBaileys();

      let { state, saveCreds } = await useMultiFileAuthState(PATHS.session);

      // Sisa pairing yang tidak pernah selesai (ada pairingCode/me tapi belum
      // registered). Kalau dipakai lagi, Baileys mencoba melanjutkan pairing
      // mati itu: event "qr" tidak muncul, kode baru tidak pernah diminta, dan
      // server langsung menutup koneksi dengan 401. Belum ada isi berharga di
      // sini, jadi dibersihkan saja.
      // PENTING: hanya pada connect PERTAMA proses ini. Pada reconnect setelah
      // pairing berhasil, WhatsApp mengirim 515 (restartRequired) dan creds
      // sedang dalam proses ditulis ke disk — kalau dibersihkan di situ,
      // pairing yang SUDAH berhasil ikut terhapus dan login gagal total.
      if (this.connectPertama && !state.creds.registered && (state.creds.pairingCode || state.creds.me)) {
        logger.warn('🧹 Sesi berisi sisa pairing dari run sebelumnya — dibersihkan supaya bisa minta kode baru.');
        sesi.hapusSesi();
        ({ state, saveCreds } = await useMultiFileAuthState(PATHS.session));
      }
      this.connectPertama = false;

      // Selama kena rate limit, jangan menyentuh server sama sekali.
      if (!state.creds.registered) {
        const sisa = bacaPairingState().cooldownSampai - Date.now();
        if (sisa > 0) {
          logger.warn(`⏸️  WhatsApp masih membatasi pairing untuk nomor ini — tunggu ${menitLagi(sisa)} menit lagi.`);
          this.statusTeks = `menunggu batas pairing (${menitLagi(sisa)} menit)`;
          this.sedangConnect = false;
          setTimeout(() => this.connect().catch(() => {}), Math.min(sisa + 1000, 5 * 60_000));
          return;
        }
      }
      let { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: null,
        isLatest: false,
      }));
      if (!version) {
        version = VERSI_CADANGAN;
        logger.warn(`⚠️  Gagal ambil versi WhatsApp Web terbaru — pakai cadangan v${version.join('.')}`);
      } else {
        logger.info(`📦 WhatsApp Web v${version.join('.')} (terbaru: ${isLatest})`);
      }

      const sock = makeWASocket({
        version,
        logger: waLogger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, waLogger),
        },
        // Kombinasi platform+browser ikut divalidasi WhatsApp saat pairing.
        // Ubuntu/Chrome adalah kombinasi yang diterima untuk login pairing code;
        // kombinasi lain bisa menghasilkan kode yang ditolak HP.
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        emitOwnEvents: false,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 1_000,
        // Cache metadata grup -> mencegah rate-limit saat kirim ke banyak grup.
        cachedGroupMetadata: async (jid) => {
          const hit = this.groupCache.get(jid);
          if (hit && Date.now() - hit.ts < 10 * 60_000) return hit.data;
          return undefined;
        },
        getMessage: async () => undefined,
      });

      // Lepas socket lama supaya listener tidak menumpuk saat reconnect.
      if (this.sock && this.sock !== sock) {
        try {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.end?.(undefined);
        } catch {
          /* noop */
        }
      }

      this.sock = sock;
      this.qrDicetak = false;
      this.pairingDiminta = false;
      // Server membalas error lewat stanza <iq type="error">. Tanpa ini, 429
      // hanya muncul sebagai baris debug dan bot terus mencoba tanpa sadar.
      sock.ws.on('CB:iq,type:error', (node) => {
        const e = (node?.content || []).find((c) => c.tag === 'error');
        const kode = e?.attrs?.code;
        const teks = e?.attrs?.text;
        if (kode === '429' || teks === 'rate-overlimit') this.kenaRateLimit();
        else logger.warn({ kode, teks }, '⚠️  Server WhatsApp membalas error');
      });

      sock.ev.on('creds.update', async () => {
        // Tandai begitu pairing benar-benar diterima WhatsApp. Sesudah ini
        // folder sesi TIDAK BOLEH dihapus oleh jalur pemulihan apa pun.
        if (!this.pairingSukses && sock.authState?.creds?.registered) {
          this.pairingSukses = true;
          logger.info('🔗 Pairing diterima WhatsApp — menyimpan sesi & menyambung ulang…');
        }
        try {
          await saveCreds();
        } catch (e) {
          logger.error({ err: e.message }, '❌ Gagal menyimpan sesi ke folder session/');
        }
      });
      // Listener dipasang DULU supaya tidak ada event yang terlewat.
      sock.ev.on('connection.update', (update) => this.onConnectionUpdate(update, saveCreds));

      // Pairing code TIDAK diminta di sini. Server WhatsApp menutup koneksi
      // (401) kalau klien yang belum terdaftar diam terlalu lama, jadi
      // permintaannya dipicu oleh event "qr" — penanda socket benar-benar siap.
      // Lihat mintaPairingCode() di bawah.
    } catch (e) {
      logger.error({ err: e.message }, '❌ Gagal membuat koneksi');
      this.sedangConnect = false;
      this.jadwalkanReconnect();
      return;
    }

    this.sedangConnect = false;
  }

  /** Server menolak karena terlalu sering minta pairing code. Berhenti dulu. */
  kenaRateLimit() {
    const st = bacaPairingState();
    if (st.cooldownSampai - Date.now() > 0) return; // sudah dalam cooldown
    st.cooldownSampai = Date.now() + RATE_COOLDOWN_MS;
    tulisPairingState(st);
    this.statusTeks = 'dibatasi WhatsApp (rate limit)';

    banner('WHATSAPP MEMBATASI PAIRING (429 rate-overlimit)');
    console.log('  Nomor ini terlalu sering meminta kode pairing, jadi WhatsApp');
    console.log('  menolak SEMUA percobaan berikutnya — termasuk kode yang kamu');
    console.log('  ketik dengan benar. Ini bukan kesalahan kode bot.');
    console.log('');
    console.log(`  Bot berhenti mencoba selama ${menitLagi(RATE_COOLDOWN_MS)} menit.`);
    console.log('  Mencoba terus justru memperpanjang blokirnya.');
    console.log('');
    console.log('  Alternatif tanpa menunggu — login pakai QR:');
    console.log('    LOGIN_MODE=qr npm start');
    console.log('  lalu scan QR di terminal lewat WhatsApp > Perangkat Tertaut.\n');

    try {
      this.sock?.end?.(undefined);
    } catch {
      /* noop */
    }
  }

  /**
   * Minta pairing code. Dipanggil dari event "qr" karena saat itulah socket
   * sudah selesai handshake dan siap menerima permintaan — kalau ditunda
   * (dulu: delay 4 detik), WhatsApp keburu menutup koneksi dengan 401.
   */
  async mintaPairingCode(sock) {
    if (this.pairingDiminta) return;

    const cfg = this.getConfig();
    if (cfg.bot.modeLogin === 'qr') return; // pengguna memilih login via QR

    const st = bacaPairingState();
    const sejam = Date.now() - 60 * 60 * 1000;
    st.permintaan = st.permintaan.filter((t) => t > sejam);
    if (st.permintaan.length >= MAKS_PAIRING_PER_JAM) {
      // Rem sendiri sebelum server yang merem paksa (429).
      logger.warn(
        `⚠️  Sudah ${st.permintaan.length} permintaan pairing dalam 1 jam — berhenti dulu supaya nomor tidak diblokir.`
      );
      this.kenaRateLimit();
      return;
    }
    st.permintaan.push(Date.now());
    tulisPairingState(st);

    this.pairingDiminta = true;
    const nomor = String(cfg.bot.nomorBot || '').replace(/[^0-9]/g, '');

    if (cfg.bot._nomorBentrok) {
      banner('NOMOR BOT BENTROK');
      console.log(`  .env  WA_PHONE_NUMBER : ${cfg.bot._nomorBentrok === nomor ? '-' : nomor}   <-- DIPAKAI`);
      console.log(`  config.json nomorBot  : ${cfg.bot._nomorBentrok}   (diabaikan)`);
      console.log('  Kode pairing dikirim ke nomor yang DIPAKAI. Kalau kamu memasukkan');
      console.log('  kode di HP dengan nomor satunya, WhatsApp pasti bilang kodenya salah.');
      console.log('  Samakan kedua nilai itu, lalu jalankan ulang.\n');
    }

    if (!/^[0-9]{8,20}$/.test(nomor)) {
      logger.error(
        '❌ Nomor bot belum diisi/format salah. Isi "bot.nomorBot" di config.json atau env WA_PHONE_NUMBER (contoh: 6281234567890).'
      );
      return;
    }

    try {
      const code = await sock.requestPairingCode(nomor);
      const bersih = String(code || '').replace(/[^A-Z0-9]/gi, '');
      this.pairingCode = bersih.match(/.{1,4}/g)?.join('-') || code;
      this.tampilkanPairing(nomor, this.pairingCode);
      this.emit('pairing', { nomor, code: this.pairingCode });
    } catch (e) {
      // Biarkan socket berikutnya mencoba lagi.
      this.pairingDiminta = false;
      logger.error({ err: e.message }, '❌ Gagal meminta pairing code');
    }
  }

  tampilkanPairing(nomor, code) {
    banner('KODE PAIRING WHATSAPP');
    console.log(`  Nomor bot : +${nomor}   (sumber: ${this.getConfig().bot._sumberNomor})`);
    console.log('  ↑ Kode HANYA berlaku di HP dengan nomor ini.');
    console.log(`  KODE      : ${code}`);
    console.log('');
    console.log('  Cara pakai (di HP yang nomornya di atas):');
    console.log('  WhatsApp > Perangkat Tertaut > Tautkan Perangkat');
    console.log('  > "Tautkan dengan nomor telepon" > masukkan kode di atas.');
    console.log('  Kode berlaku sekitar 60 detik. Kalau kedaluwarsa, tunggu bot minta kode baru.\n');
    logger.info(`🔑 Pairing code: ${code}`);
  }

  async onConnectionUpdate(update, saveCreds) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    const DisconnectReason = baileysSiap()?.DisconnectReason || {};

    if (qr) {
      this.statusTeks = 'menunggu QR / pairing';

      // Socket sudah siap -> inilah saat yang tepat meminta pairing code.
      if (!this.sock?.authState?.creds?.registered) {
        this.mintaPairingCode(this.sock);
      }

      // QR: jadi mode utama kalau LOGIN_MODE=qr, selain itu cuma cadangan.
      const modeQr = this.getConfig().bot.modeLogin === 'qr';
      if (!this.qrDicetak) {
        this.qrDicetak = true;
        if (modeQr) {
          banner('SCAN QR INI DENGAN WHATSAPP');
          qrcode.generate(qr, { small: true });
          console.log('  WhatsApp di HP > Perangkat Tertaut > Tautkan Perangkat > scan QR di atas.');
          console.log('  QR berganti otomatis selama bot jalan.\n');
        } else {
          console.log('\n(QR cadangan — abaikan kalau kamu pakai pairing code)\n');
          qrcode.generate(qr, { small: true });
        }
      }
    }

    if (connection === 'connecting') {
      this.statusTeks = 'menghubungkan…';
      logger.info('🔄 Menghubungkan ke WhatsApp…');
    }

    if (isNewLogin) logger.info('✅ Perangkat berhasil ditautkan');

    if (connection === 'open') {
      this.siap = true;
      this.percobaan = 0;
      this.pairingGagal = 0;
      this.pairingCode = null;
      this.statusTeks = 'terhubung';
      const me = this.sock.user;
      banner('BOT TERHUBUNG KE WHATSAPP');
      logger.info(`✅ Login sebagai: ${me?.name || '-'} (${me?.id?.split(':')[0] || '-'})`);
      try {
        await saveCreds();
      } catch {
        /* noop */
      }
      this.emit('ready', this.sock);
      return;
    }

    if (connection === 'close') {
      this.siap = false;
      const err = lastDisconnect?.error;
      const code = statusCode(err);
      const alasan =
        Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || `kode ${code}`;
      this.statusTeks = `terputus (${alasan})`;
      this.emit('closed', { code, alasan });
      logger.debug({ code, alasan, err: err?.message, data: err?.data }, 'connection close');

      const sudahTerdaftar = !!this.sock?.authState?.creds?.registered;

      if (code === DisconnectReason.loggedOut || code === 401) {
        // Belum pernah terdaftar = belum ada sesi untuk dicabut. Ini cuma
        // pairing yang gagal/kedaluwarsa. Menghapus folder sesi di sini justru
        // membuat bot berputar-putar tanpa pernah selesai pairing.
        if (!sudahTerdaftar && !this.pairingSukses) {
          // Pairing tidak pernah selesai. creds.json sekarang berisi sisa
          // percobaan tadi (pairingCode + me yang sudah basi); kalau dipakai
          // lagi, Baileys mencoba melanjutkan pairing mati itu, event "qr"
          // tidak pernah muncul, dan bot berputar tanpa kode baru.
          // Isinya belum bernilai apa pun, jadi aman dibuang.
          this.pairingGagal += 1;
          sesi.hapusSesi();
          logger.warn(
            `⚠️  Pairing belum selesai (kode kedaluwarsa / tidak dimasukkan) — meminta kode baru… (percobaan ke-${this.pairingGagal})`
          );
          if (this.pairingGagal === 3) {
            banner('PAIRING BERKALI-KALI GAGAL');
            console.log('  Periksa hal berikut:');
            console.log(`  1. Nomor "bot.nomorBot" di config.json = ${this.getConfig().bot.nomorBot}`);
            console.log('     Pastikan itu nomor WhatsApp yang aktif, format 62xxx tanpa "+" dan tanpa "0" di depan.');
            console.log('  2. Masukkan kode SEBELUM 60 detik: WhatsApp > Perangkat Tertaut');
            console.log('     > Tautkan Perangkat > "Tautkan dengan nomor telepon".');
            console.log('  3. Kode selalu 8 karakter. Ketik tanpa tanda "-".\n');
          }
          this.percobaan = 0;
          return this.jadwalkanReconnect(4000);
        }

        banner('SESI LOGOUT — PERLU PAIRING ULANG');
        logger.warn('⚠️  Sesi dicabut dari HP. Folder session dihapus, bot akan minta pairing code baru.');
        sesi.hapusSesi();
        this.percobaan = 0;
        return this.jadwalkanReconnect(3000);
      }

      if (code === DisconnectReason.restartRequired || code === 515) {
        // Tahap WAJIB setelah pairing berhasil. Jangan dipercepat: creds baru
        // masih ditulis ke disk, dan menyambung terlalu cepat membuat login gagal.
        logger.info('🔁 Restart diminta WhatsApp (normal setelah pairing) — menyambung ulang…');
        this.percobaan = 0;
        return this.jadwalkanReconnect(3000);
      }

      // Sesi sudah terdaftar tapi koneksi gagal: jangan pernah hapus sesi di
      // sini — cukup sambung ulang. Menghapusnya memaksa pairing dari nol.
      if (this.pairingSukses && !this.siap) {
        logger.warn(`⚠️  Gagal menyelesaikan login (${alasan}) — sesi DIPERTAHANKAN, mencoba lagi…`);
        return this.jadwalkanReconnect();
      }

      if (code === DisconnectReason.badSession) {
        logger.warn('⚠️  Session file rusak — dihapus, silakan pairing ulang.');
        sesi.hapusSesi();
        return this.jadwalkanReconnect(3000);
      }

      if (code === DisconnectReason.connectionReplaced || code === 440) {
        logger.warn(
          '⚠️  Sesi diambil alih perangkat lain (WhatsApp Web dibuka di tempat lain). Menyambung ulang dalam 30 detik…'
        );
        return this.jadwalkanReconnect(30_000);
      }

      logger.warn(`⚠️  Koneksi terputus (${alasan}) — mencoba menyambung ulang…`);
      this.jadwalkanReconnect();
    }
  }

  jadwalkanReconnect(paksaMs) {
    if (this.berhenti) return;
    this.percobaan += 1;
    const backoff =
      paksaMs ?? Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(1.6, Math.min(this.percobaan, 10)));
    const ms = Math.round(backoff + randInt(0, 1500));
    logger.info(`⏳ Reconnect dalam ${(ms / 1000).toFixed(1)} detik (percobaan ke-${this.percobaan})`);
    setTimeout(() => this.connect().catch(() => {}), ms);
  }

  // ------------------------------------------------------------------
  //  Grup
  // ------------------------------------------------------------------

  /** Ambil semua grup yang diikuti bot: { id, nama, jumlahAnggota, ... } */
  async ambilSemuaGrup() {
    if (!this.connected) throw new Error('Bot belum terhubung ke WhatsApp');
    const raw = await this.sock.groupFetchAllParticipating();
    const potong = (v) => (v || '').toString().split('@')[0].split(':')[0];
    const idSaya = new Set(
      [potong(this.sock.user?.id), potong(this.sock.user?.lid)].filter(Boolean)
    );
    const list = Object.values(raw || {}).map((g) => {
      this.groupCache.set(g.id, { data: g, ts: Date.now() });
      const saya = (g.participants || []).find(
        (p) => idSaya.has(potong(p.id)) || idSaya.has(potong(p.lid)) || idSaya.has(potong(p.jid))
      );
      return {
        id: g.id,
        nama: g.subject || '(tanpa nama)',
        jumlahAnggota: (g.participants || []).length,
        dibuat: g.creation ? new Date(g.creation * 1000).toISOString() : null,
        pemilik: g.owner || null,
        // null = tidak bisa dipastikan (jangan dipakai untuk memblokir pengiriman)
        botAdmin: saya ? saya.admin === 'admin' || saya.admin === 'superadmin' : null,
        hanyaAdminBisaKirim: !!g.announce,
      };
    });
    list.sort((a, b) => a.nama.localeCompare(b.nama, 'id'));
    return list;
  }

  // ------------------------------------------------------------------
  //  Kirim pesan
  // ------------------------------------------------------------------

  /**
   * Kirim satu pesan (teks / gambar+caption) ke sebuah JID.
   * @param {string} jid  contoh: 1203630xxxx@g.us
   * @param {{teks?: string, media?: {url?: string, buffer?: Buffer}}} isi
   */
  async kirim(jid, isi, opsi = {}) {
    if (!this.connected) throw new Error('Bot belum terhubung ke WhatsApp');

    if (opsi.tampilkanSedangMengetik) {
      try {
        await this.sock.presenceSubscribe(jid);
        await delay(randInt(400, 900));
        await this.sock.sendPresenceUpdate('composing', jid);
        await delay(randInt(800, 1800));
        await this.sock.sendPresenceUpdate('paused', jid);
      } catch {
        /* presence gagal bukan masalah fatal */
      }
    }

    let payload;
    if (isi.media) {
      const gambar = isi.media.buffer ? isi.media.buffer : { url: isi.media.url };
      payload = { image: gambar, caption: isi.teks || undefined };
    } else {
      payload = { text: isi.teks || '' };
    }

    const hasil = await this.sock.sendMessage(jid, payload);
    return hasil;
  }
}

module.exports = { WhatsAppClient };
