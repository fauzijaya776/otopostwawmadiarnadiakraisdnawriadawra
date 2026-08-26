'use strict';

/**
 * Loader Baileys yang tahan banting.
 *
 * Kenapa perlu file ini?
 *   - Paket "baileys" >= 6.7.19 dan "@whiskeysockets/baileys" >= 6.7.19 dirilis
 *     sebagai ES Module murni, jadi require() langsung melempar ERR_REQUIRE_ESM.
 *   - Build ESM itu juga memakai sintaks import attributes (`with { type: 'json' }`)
 *     yang baru didukung Node >= 20.10, sehingga di Node 20.9 import() pun gagal.
 *
 * Jadi: coba require() dulu (versi CommonJS), kalau paketnya ternyata ESM baru
 * jatuh ke dynamic import(). Dengan begitu proyek tetap CommonJS dan tidak perlu
 * diubah lagi kalau nanti Node/Baileys dinaikkan versinya.
 */

const KANDIDAT = ['baileys', '@whiskeysockets/baileys'];

let cache = null;
let janji = null;

function esm(err) {
  return err?.code === 'ERR_REQUIRE_ESM' || /require\(\) of ES Module/i.test(err?.message || '');
}

/** Samakan bentuk export CommonJS dan ESM jadi satu objek biasa. */
function normalisasi(mod, nama) {
  let m = mod;
  // Namespace ESM yang membungkus modul CommonJS menaruh isinya di ".default".
  if (typeof m?.useMultiFileAuthState !== 'function' && typeof m?.default?.useMultiFileAuthState === 'function') {
    m = m.default;
  }

  // makeWASocket diekspor sebagai default export di semua versi.
  const makeWASocket = typeof m?.default === 'function' ? m.default : m?.makeWASocket;
  if (typeof makeWASocket !== 'function') {
    throw new Error(`Paket "${nama}" tidak mengekspor makeWASocket — versinya tidak cocok.`);
  }

  return { ...m, makeWASocket, __paket: nama };
}

async function muat(nama) {
  try {
    return normalisasi(require(nama), nama);
  } catch (e) {
    if (!esm(e)) throw e;
    // Versi ESM: require() tidak bisa, pakai dynamic import().
    return normalisasi(await import(nama), nama);
  }
}

/** Ambil API Baileys (di-cache; aman dipanggil berkali-kali). */
async function ambilBaileys() {
  if (cache) return cache;
  if (janji) return janji;

  janji = (async () => {
    const gagal = [];
    for (const nama of KANDIDAT) {
      try {
        cache = await muat(nama);
        return cache;
      } catch (e) {
        if (e?.code === 'MODULE_NOT_FOUND' && String(e.message).includes(nama)) continue;
        gagal.push(`${nama}: ${e.message}`);
      }
    }
    janji = null;
    const detail = gagal.length ? '\n   • ' + gagal.join('\n   • ') : '';
    throw new Error(
      'Gagal memuat Baileys. Jalankan "npm install", pastikan Node >= 20.10 ' +
        `kalau memakai Baileys versi ESM (Node sekarang ${process.version}).${detail}`
    );
  })();

  return janji;
}

/** API yang sudah termuat, atau null kalau ambilBaileys() belum pernah selesai. */
function baileysSiap() {
  return cache;
}

module.exports = { ambilBaileys, baileysSiap };
