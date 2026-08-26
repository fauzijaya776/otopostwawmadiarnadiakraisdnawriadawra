'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PATHS } = require('./paths');
const { logger } = require('./logger');

/** Apakah folder sesi sudah berisi kredensial hasil login? */
function punyaSesi() {
  try {
    return fs.existsSync(path.join(PATHS.session, 'creds.json'));
  } catch {
    return false;
  }
}

/** Bungkus seluruh isi folder sesi jadi satu string base64 (gzip). */
function exportBase64() {
  if (!punyaSesi()) throw new Error('Belum ada sesi. Login dulu (pairing code) sampai berhasil.');
  const bundle = {};
  for (const name of fs.readdirSync(PATHS.session)) {
    const f = path.join(PATHS.session, name);
    if (fs.statSync(f).isFile()) bundle[name] = fs.readFileSync(f, 'utf8');
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')).toString('base64');
}

/** Kebalikan exportBase64: tulis ulang folder sesi dari string base64. */
function importBase64(b64, { timpa = false } = {}) {
  if (!b64) return false;
  if (punyaSesi() && !timpa) return false;
  const json = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  const bundle = JSON.parse(json);
  fs.mkdirSync(PATHS.session, { recursive: true });
  let n = 0;
  for (const [name, isi] of Object.entries(bundle)) {
    if (name.includes('/') || name.includes('\\')) continue; // jaga-jaga path traversal
    fs.writeFileSync(path.join(PATHS.session, name), isi, 'utf8');
    n++;
  }
  return n > 0;
}

/** Dipanggil saat boot: pulihkan sesi dari env SESSION_B64 kalau folder masih kosong. */
function pulihkanDariEnv() {
  const b64 = (process.env.SESSION_B64 || '').trim();
  if (!b64) return false;
  try {
    const ok = importBase64(b64);
    if (ok) logger.info('🔐 Sesi dipulihkan dari environment variable SESSION_B64');
    return ok;
  } catch (e) {
    logger.error({ err: e.message }, '❌ Gagal memulihkan SESSION_B64 (isinya mungkin rusak)');
    return false;
  }
}

/** Hapus sesi (dipakai saat logout dari HP / mau pairing ulang). */
function hapusSesi() {
  try {
    fs.rmSync(PATHS.session, { recursive: true, force: true });
    fs.mkdirSync(PATHS.session, { recursive: true });
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'Gagal menghapus folder sesi');
    return false;
  }
}

module.exports = { punyaSesi, exportBase64, importBase64, pulihkanDariEnv, hapusSesi };
