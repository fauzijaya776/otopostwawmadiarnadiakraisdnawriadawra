'use strict';

const fs = require('fs');
const { PATHS } = require('./paths');
const { logger } = require('./logger');
const { saveConfig, normalizeGroupId } = require('./config');

/** Daftar grup terakhir yang berhasil diambil (dipakai endpoint /groups). */
let terakhir = { diambilPada: null, jumlah: 0, grup: [] };

function getTerakhir() {
  return terakhir;
}

const bersih = (s) =>
  (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Tulis groups.json + tampilkan tabel di terminal. */
function simpanDanTampilkan(grup, { tulisFile = true, tampilkan = true } = {}) {
  terakhir = { diambilPada: new Date().toISOString(), jumlah: grup.length, grup };

  if (tulisFile) {
    try {
      fs.writeFileSync(
        PATHS.groupsJson,
        JSON.stringify(
          {
            _petunjuk:
              'File ini dibuat otomatis. Salin "id" grup yang diinginkan ke "grupTujuan" di config.json. Alternatif: cukup tulis "nama" grupnya di config.json, ID akan diisi otomatis.',
            diambilPada: terakhir.diambilPada,
            jumlah: grup.length,
            grup,
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      logger.info(`💾 Daftar grup disimpan ke groups.json (${grup.length} grup)`);
    } catch (e) {
      logger.warn({ err: e.message }, 'Gagal menulis groups.json');
    }
  }

  if (tampilkan) {
    console.log('\n================= DAFTAR GRUP =================');
    if (grup.length === 0) {
      console.log('  (bot belum tergabung di grup mana pun)');
    }
    grup.forEach((g, i) => {
      const flag = [
        g.botAdmin === true ? 'BOT-ADMIN' : g.botAdmin === null ? 'ADMIN?' : null,
        g.hanyaAdminBisaKirim ? 'HANYA-ADMIN-BISA-KIRIM' : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(
        `${String(i + 1).padStart(3)}. ${g.nama}\n     id  : ${g.id}\n     info: ${g.jumlahAnggota} anggota${flag ? ' [' + flag + ']' : ''}`
      );
    });
    console.log('===============================================\n');
  }

  return terakhir;
}

/**
 * Cocokkan setiap entri "grupTujuan" di config dengan grup asli.
 * - Kalau "id" sudah diisi -> dipakai langsung (nama disegarkan).
 * - Kalau "id" kosong -> dicari dari "nama" (persis dulu, lalu sebagian).
 * Hasil ID yang ketemu ditulis balik ke config.json bila diizinkan.
 */
function resolveTargets(cfg, grup) {
  const byId = new Map(grup.map((g) => [g.id, g]));
  const byNama = new Map();
  for (const g of grup) {
    const k = bersih(g.nama);
    if (!byNama.has(k)) byNama.set(k, g);
  }

  const hasil = [];
  const perluDitulis = [];

  cfg.grupTujuan.forEach((t, idx) => {
    if (!t.aktif) return;

    let cocok = null;
    let sumber = '';

    if (t.id && byId.has(t.id)) {
      cocok = byId.get(t.id);
      sumber = 'id';
    } else if (t.id) {
      // ID ditulis manual tapi bot tidak tergabung di grup itu -> tetap dicoba kirim.
      hasil.push({
        id: t.id,
        nama: t.nama || t.id,
        cocok: false,
        catatan: 'ID ada di config tapi bot tidak terdeteksi sebagai anggota grup ini',
      });
      return;
    }

    if (!cocok && t.nama) {
      const key = bersih(t.nama);
      cocok = byNama.get(key) || null;
      if (cocok) sumber = 'nama-persis';
      if (!cocok) {
        const kandidat = grup.filter((g) => bersih(g.nama).includes(key) && key.length >= 3);
        if (kandidat.length === 1) {
          cocok = kandidat[0];
          sumber = 'nama-sebagian';
        } else if (kandidat.length > 1) {
          logger.warn(
            `⚠️  Nama grup "${t.nama}" cocok dengan ${kandidat.length} grup (${kandidat
              .map((k) => k.nama)
              .join(', ')}). Isi "id" secara manual di config.json.`
          );
        }
      }
    }

    if (!cocok) {
      logger.warn(`⚠️  Grup tujuan "${t.nama || t.id || '(kosong)'}" tidak ditemukan — dilewati.`);
      return;
    }

    if (!t.id || t.nama !== cocok.nama) perluDitulis.push({ idx, id: cocok.id, nama: cocok.nama });

    hasil.push({
      id: cocok.id,
      nama: cocok.nama,
      cocok: true,
      sumber,
      botAdmin: cocok.botAdmin,
      hanyaAdminBisaKirim: cocok.hanyaAdminBisaKirim,
    });
  });

  if (perluDitulis.length && cfg.opsi.isiOtomatisIdGrupDariNama) {
    try {
      saveConfig((raw) => {
        raw.grupTujuan = Array.isArray(raw.grupTujuan) ? raw.grupTujuan : [];
        for (const p of perluDitulis) {
          if (!raw.grupTujuan[p.idx]) continue;
          raw.grupTujuan[p.idx].id = normalizeGroupId(p.id);
          raw.grupTujuan[p.idx].nama = p.nama;
        }
        return raw;
      });
      logger.info(`✍️  ${perluDitulis.length} ID grup diisi otomatis ke config.json`);
    } catch (e) {
      logger.warn({ err: e.message }, 'Gagal menulis ID grup ke config.json');
    }
  }

  // Buang duplikat id
  const unik = [];
  const seen = new Set();
  for (const h of hasil) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    unik.push(h);
  }
  return unik;
}

module.exports = { simpanDanTampilkan, resolveTargets, getTerakhir };
