# 🤖 WhatsApp Auto Post Bot

Bot auto post WhatsApp berbasis **[Baileys](https://github.com/WhiskeySockets/Baileys) 7.0.0-rc14**.
Kirim **teks + gambar** ke banyak **grup** secara otomatis dengan **interval yang diatur lewat file**.
Login pakai **pairing code** (tanpa scan QR), dan **siap deploy di Render**.

| Fitur | Keterangan |
|---|---|
| Login | Pairing code 8 digit (tanpa QR) |
| Target | Banyak grup sekaligus |
| Isi pesan | Teks, gambar (file lokal / URL), atau teks + gambar |
| Interval | Default 30 menit — diatur di `config.json` |
| Ambil ID grup | Otomatis: ID + nama semua grup disimpan ke `groups.json` |
| Set grup | Cukup tulis **nama grup**, ID diisi otomatis ke `config.json` |
| Jalan otomatis | Begitu `npm start` / deploy, langsung nyala |
| Hosting | Render (Web Service, free tier bisa) |
| Node.js | **20, 22, 24** (semua LTS aktif) |

---

## 📁 Isi project

```
projectbaru/
├─ config.json          ← SEMUA PENGATURAN ADA DI SINI
├─ groups.json          ← dibuat otomatis: daftar ID + nama grup
├─ media/               ← taruh gambar di sini
│  └─ promo1.jpg
├─ src/
│  ├─ index.js          ← titik masuk aplikasi
│  ├─ whatsapp.js       ← koneksi Baileys + pairing code
│  ├─ scheduler.js      ← mesin auto post (interval)
│  ├─ groups.js         ← ambil & cocokkan grup
│  ├─ config.js         ← baca config.json + hot reload
│  ├─ server.js         ← HTTP /health & /status (untuk Render)
│  ├─ session.js        ← backup sesi login ke base64
│  ├─ state.js, utils.js, paths.js, logger.js
├─ scripts/
│  ├─ list-groups.js    ← npm run groups
│  ├─ session-export.js ← npm run session:export
│  ├─ session-reset.js  ← npm run session:reset
│  └─ check.js          ← npm run check
├─ render.yaml          ← blueprint deploy Render
├─ .env.example
└─ package.json
```

---

## 🚀 Cara jalan di komputer (CMD / Terminal)

### 1. Syarat
Node.js **20 ke atas**. Cek dulu:
```bash
node -v
```

### 2. Install
```bash
cd projectbaru
npm install
```

### 3. Isi nomor bot
Buka `config.json`, ganti bagian ini dengan nomor WhatsApp yang akan dipakai bot:
```json
"bot": {
  "nomorBot": "6281234567890",
  "namaBot": "AutoPost Bot",
  "timezone": "Asia/Jakarta"
}
```
> Format internasional, **tanpa `+`, tanpa spasi, tanpa `-`**.
> `08123...` ditulis jadi `628123...`

Cek dulu kalau mau:
```bash
npm run check
```

### 4. Jalankan
```bash
npm start
```

Di layar akan muncul:

```
==============================================
  KODE PAIRING WHATSAPP
==============================================
  Nomor bot : +6281234567890
  KODE      : ABCD-1234
```

### 5. Masukkan kode di HP
WhatsApp di HP → **Perangkat Tertaut** → **Tautkan Perangkat** →
**"Tautkan dengan nomor telepon"** → masukkan kode `ABCD-1234`.

> Kode berlaku ± 60 detik. Kalau kedaluwarsa, biarkan saja — bot otomatis minta kode baru.

### 6. Ambil ID grup
Begitu terhubung, bot **langsung menampilkan semua grup** dan menyimpannya ke `groups.json`:

```
================= DAFTAR GRUP =================
  1. Grup Jualan A
     id  : 120363111111111111@g.us
     info: 50 anggota
  2. Info Reseller
     id  : 120363333333333333@g.us
     info: 5 anggota [BOT-ADMIN]
===============================================
```

Mau ambil daftar grup saja tanpa menjalankan bot?
```bash
npm run groups
```

---

## ⚙️ Pengaturan — `config.json`

Ubah file ini kapan saja. **Bot membaca ulang otomatis, tidak perlu restart.**

```json
{
  "bot": {
    "nomorBot": "6281234567890",
    "namaBot": "AutoPost Bot",
    "timezone": "Asia/Jakarta"
  },

  "jadwal": {
    "aktif": true,
    "intervalMenit": 30,
    "kirimSaatStart": true,
    "delaySebelumKirimPertamaDetik": 25,
    "jedaAntarGrupDetik": 45,
    "jitterDetik": 30,
    "jamAktif": { "aktif": false, "mulai": "07:00", "selesai": "22:00" },
    "hariAktif": [0, 1, 2, 3, 4, 5, 6]
  },

  "grupTujuan": [
    { "aktif": true, "nama": "Grup Jualan A", "id": "" },
    { "aktif": true, "nama": "Info Reseller", "id": "120363333333333333@g.us" }
  ],

  "pesan": {
    "mode": "urut",
    "daftar": [
      { "aktif": true, "teks": "Halo {{namaGrup}}!", "gambar": "" },
      { "aktif": true, "teks": "Promo hari ini", "gambar": "media/promo1.jpg" }
    ]
  },

  "opsi": {
    "tulisGroupsJson": true,
    "isiOtomatisIdGrupDariNama": true,
    "tampilkanSedangMengetik": true,
    "hentikanJikaSemuaGrupGagal": false
  }
}
```

### Penjelasan tiap pengaturan

**`jadwal`**

| Kunci | Arti |
|---|---|
| `aktif` | `false` = auto post dimatikan (bot tetap online) |
| `intervalMenit` | Jarak antar pengiriman. **30** = tiap 30 menit |
| `kirimSaatStart` | `true` = langsung kirim sekali begitu bot nyala |
| `delaySebelumKirimPertamaDetik` | Jeda sebelum kiriman pertama (beri waktu koneksi stabil) |
| `jedaAntarGrupDetik` | Jeda antar grup dalam satu siklus (anti-spam) |
| `jitterDetik` | Tambahan waktu acak 0–N detik supaya pola tidak kaku |
| `jamAktif` | `aktif: true` = hanya kirim di rentang jam tersebut |
| `hariAktif` | `0`=Minggu … `6`=Sabtu. Contoh Senin–Jumat: `[1,2,3,4,5]` |

**`grupTujuan`** — dua cara mengisi:

1. **Pakai nama saja** (paling gampang) — kosongkan `id`, bot mencarikan dan **menulis ID-nya sendiri** ke `config.json`:
   ```json
   { "aktif": true, "nama": "Grup Jualan A", "id": "" }
   ```
2. **Pakai ID langsung** — salin dari `groups.json`:
   ```json
   { "aktif": true, "nama": "bebas", "id": "120363111111111111@g.us" }
   ```

> `"aktif": false` untuk menonaktifkan grup tanpa menghapusnya.

**`pesan`**

| Kunci | Arti |
|---|---|
| `mode` | `"urut"` = pesan bergilir 1→2→3→1… · `"acak"` = dipilih acak |
| `daftar[].teks` | Isi pesan. Format WA berlaku: `*tebal*`, `_miring_`, `~coret~` |
| `daftar[].gambar` | `""` (teks saja) · `"media/promo1.jpg"` · `"https://.../foto.jpg"` |
| `daftar[].aktif` | `false` untuk melewati pesan ini |

**Placeholder di dalam teks:**

| Kode | Hasil |
|---|---|
| `{{namaGrup}}` | Nama grup tujuan |
| `{{idGrup}}` | ID grup tujuan |
| `{{namaBot}}` | Isi `bot.namaBot` |
| `{{tanggal}}` | 22 Agustus 2026 |
| `{{tanggalPendek}}` | 22/08/2026 |
| `{{jam}}` | 16:58 |
| `{{hari}}` | Sabtu |

---

## ☁️ Deploy di Render

### 1. Push ke GitHub
```bash
git init
git add .
git commit -m "wa autopost bot"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```
> `session/` dan `.env` sudah diabaikan lewat `.gitignore` — aman.

### 2. Buat service
Render → **New** → **Blueprint** → pilih repo ini (`render.yaml` sudah disiapkan).
Atau manual: **New → Web Service**

| Kolom | Isi |
|---|---|
| Runtime | Node |
| Build Command | `npm install --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Region | Singapore |

### 3. Environment Variables

| Key | Value |
|---|---|
| `NODE_VERSION` | `22.11.0` (boleh `20.x` / `24.x`) |
| `WA_PHONE_NUMBER` | `6281234567890` |
| `KEEPALIVE` | `true` |
| `SESSION_B64` | *(diisi di langkah 5)* |
| `ADMIN_TOKEN` | *(opsional, token untuk endpoint kontrol)* |

### 4. Pairing di Render
Setelah deploy, buka **Logs** — kode pairing muncul di sana.
Atau buka `https://NAMA-SERVICE.onrender.com/pairing`.

### 5. ⭐ Supaya tidak pairing ulang tiap redeploy
Filesystem Render bersifat *ephemeral*: folder `session/` hilang setiap deploy ulang.
Solusinya, simpan sesi ke environment variable.

**Cara paling mudah — login dulu di komputer:**
```bash
npm start                 # login pairing code sampai "BOT TERHUBUNG"
# Ctrl+C
npm run session:export    # hasilnya di data/session-b64.txt
```
Salin seluruh isi `data/session-b64.txt` → Render → **Environment** → `SESSION_B64` → Save.

**Atau ambil langsung dari server yang sudah login:**
```
https://NAMA-SERVICE.onrender.com/session?token=ADMIN_TOKEN_KAMU
```

> ⚠️ Nilai `SESSION_B64` = akses penuh ke akun WhatsApp bot. Jangan dibagikan / di-commit.

### 6. Free tier & sleep
Render free menidurkan service setelah ~15 menit tanpa trafik — interval 30 menit bisa terlewat.
`KEEPALIVE=true` membuat bot nge-ping dirinya sendiri tiap 10 menit sehingga tetap bangun.
Untuk 100% stabil, gunakan plan **Starter** (`plan: starter` di `render.yaml`).

---

## 🌐 Endpoint HTTP

| Endpoint | Fungsi |
|---|---|
| `GET /` | Halaman status (tampilan web) |
| `GET /health` | Health check Render |
| `GET /status` | Status lengkap (JSON) |
| `GET /pairing` | Lihat kode pairing terbaru |
| `GET /groups` | Daftar grup (`?refresh=1` untuk ambil ulang) |
| `POST /send-now` | Kirim sekarang juga, di luar jadwal |
| `GET /session` | Ambil backup sesi (base64) |

Kalau `ADMIN_TOKEN` diisi, tambahkan header `x-admin-token: <token>` atau `?token=<token>`
untuk `/groups`, `/send-now`, dan `/session`.

Contoh kirim manual:
```bash
curl -X POST https://NAMA-SERVICE.onrender.com/send-now -H "x-admin-token: RAHASIA"
```

---

## 🧰 Perintah npm

| Perintah | Fungsi |
|---|---|
| `npm start` | Jalankan bot |
| `npm run check` | Cek config + pratinjau pesan (tanpa konek WA) |
| `npm run groups` | Ambil ID & nama semua grup |
| `npm run session:export` | Export sesi ke base64 untuk `SESSION_B64` |
| `npm run session:reset` | Hapus sesi, pairing dari awal |

---

## ❓ Masalah umum

**Kode pairing tidak muncul**
Nomor salah format. Harus `628…`, tanpa `+` / spasi / `-`. Jalankan `npm run check`.

**"Connection Failure" berulang / kode selalu kedaluwarsa**
Hapus sesi lalu ulangi: `npm run session:reset` → `npm start`.
Pastikan juga jam komputer/server sudah benar.

**Pesan tidak terkirim ke sebuah grup**
Cek log. Kalau tertulis *"grup hanya mengizinkan admin"*, bot harus dijadikan admin,
atau setelan grup diubah ke "Semua peserta".

**Gambar tidak terkirim**
Jalankan `npm run check` — bagian `gambar` akan menampilkan `file ok` atau pesan error.
Pastikan file ada di folder `media/` dan ditulis benar di `config.json`.

**Grup tidak ketemu padahal namanya benar**
Nama grup harus persis, atau unik kalau hanya sebagian. Cara paling aman: salin `id` dari `groups.json`.

**Bot di Render mati sendiri**
Aktifkan `KEEPALIVE=true`, atau naikkan ke plan Starter.

**Sesi tiba-tiba logout**
Terjadi kalau perangkat dicabut dari HP, atau nomor dipakai login di tempat lain.
Bot otomatis menghapus sesi dan minta pairing code baru.

---

## ⚠️ Catatan penting

- Baileys adalah library **tidak resmi**. Pengiriman terlalu sering / spam bisa membuat nomor **diblokir WhatsApp**.
- Interval 30 menit dengan jeda antar grup 8 detik sudah tergolong aman. Jangan turunkan `intervalMenit` di bawah 15 tanpa alasan.
- Gunakan nomor cadangan, bukan nomor utama.
- Kirim hanya ke grup yang memang mengizinkan promosi.

---

## 🐢 Jeda antar grup (anti-spam)

Bot menunggu di antara setiap grup, bukan mengirim sekaligus. Diatur di
`config.json` bagian `jadwal`:

| Setelan | Arti |
|---|---|
| `jedaAntarGrupDetik` | Jeda dasar antar grup |
| `jitterDetik` | Tambahan acak 0–N detik, supaya polanya tidak seragam |

Setelan sekarang: **45 + 0–30 detik** → tiap grup berjarak 45–75 detik.
Dengan 20 grup, satu siklus makan **14–24 menit**.

Jitter itu penting: jeda yang selalu persis sama justru terlihat seperti bot.

Saat bot start, tempo ini dicetak, dan bot memperingatkan kalau satu siklus
berisiko lebih lama dari `intervalMenit` — kalau itu terjadi, siklus
berikutnya akan dilewati begitu saja.

> Interval antar siklus diatur terpisah lewat `jadwal.intervalMenit`
> (sekarang 60 menit). Jangan sampai durasi siklus melebihi interval.

---

## 📋 Memilih grup tujuan

Setelah bot login, ambil daftar grup:

```bash
npm run groups
```

Hasilnya tersimpan di `groups.json` + `daftar-grup.txt`. Perintah lain:

| Perintah | Fungsi |
|---|---|
| `npm run groups` | Ambil ulang dari WhatsApp (bot harus sudah login) |
| `npm run groups:offline` | Baca dari `groups.json` — tidak perlu konek |
| `npm run groups:snippet` | Cetak blok `grupTujuan` siap tempel ke `config.json` |

Daftar diurutkan dari grup paling ramai. Grup bertanda 🔒 **TIDAK BISA KIRIM**
(hanya admin yang boleh kirim dan bot bukan admin) — grup ini otomatis
disaring dari snippet.

### Cara memilih

`config.json` sudah berisi semua grup yang bisa dikirimi, semuanya dalam
keadaan `"aktif": false`. Cukup ubah jadi `true` pada grup yang kamu mau:

```json
{ "aktif": true, "nama": "Nama Grup", "id": "1203630xxxxx@g.us" }
```

Cek hasilnya tanpa mengirim apa pun:

```bash
npm run check
```

---

## 🚫 "Pairing code salah" padahal sudah benar

Cek dulu apakah server membalas **429 `rate-overlimit`**:

```bash
npm run debug
```

Lalu cari `rate-overlimit` di `debug.log`.

WhatsApp membatasi berapa sering satu nomor boleh meminta kode pairing. Sekali
kena batas, **semua** percobaan berikutnya ditolak — termasuk kode yang diketik
dengan benar. Gejalanya persis seperti "kode salah": HP loading lama lalu gagal.

Bot sekarang menanganinya sendiri:

- Berhenti otomatis `1 jam` begitu 429 terdeteksi (mencoba terus memperpanjang blokir)
- Membatasi diri maksimal **4 permintaan pairing per jam** sebelum server yang merem
- Statusnya disimpan di `data/pairing.json`, jadi restart bot tidak melewati masa tunggu

### Jalan pintas: login pakai QR

QR **tidak kena batas yang sama**, jadi bisa dipakai langsung:

```bash
LOGIN_MODE=qr npm start
```

Scan QR di terminal lewat WhatsApp > Perangkat Tertaut > Tautkan Perangkat.
Bisa juga disetel permanen lewat `LOGIN_MODE` di `.env` atau `bot.modeLogin` di `config.json`.

---

## 🔄 Ganti versi Baileys

Project ini memakai `baileys@7.0.0-rc14` — rilis **terbaru**, dan satu-satunya
jalur yang implementasi pairing-nya masih cocok dengan protokol WhatsApp sekarang.

Versinya **di-pin persis** (tanpa `^`) karena ini prerelease.

### Kenapa bukan 6.7.x?

`6.7.x` sudah tua dan pairing code-nya ditolak HP. Perhatikan juga urutan
semver Baileys yang membingungkan: **6.17.16 lebih baru dari 6.7.24**.

### Soal CommonJS vs ESM

`7.0.0-rc14` adalah ESM, jadi tidak bisa di-`require()` langsung dari project
CommonJS ini. [`src/baileys.js`](src/baileys.js) menanganinya: `require()` dulu,
kalau kena `ERR_REQUIRE_ESM` otomatis pindah ke `import()`.

Rilis `6.7.19`–`6.7.24` **tidak bisa dipakai di Node < 20.10** karena memakai
sintaks `import ... with { type: 'json' }`. `7.0.0-rc14` sudah tidak memakainya,
jadi aman di Node 20.9.
