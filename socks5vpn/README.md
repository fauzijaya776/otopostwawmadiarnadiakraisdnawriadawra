# Socks5 VPN (Android, Kotlin)

Aplikasi kecil untuk menyambungkan aplikasi tertentu (mis. Brave saja) ke SOCKS5 proxy.
Input cukup satu baris: `host:port:username:password` (atau `host:port` kalau tanpa auth).

## Cara kerja (tanpa root)

Android tidak punya API "pakai SOCKS5 untuk app X". Jadi dipakai kombinasi:

1. `VpnService` dibuat dengan **allowlist per-aplikasi** (`addAllowedApplication`) —
   hanya app yang kamu centang yang masuk VPN ini.
2. VPN itu mengumumkan **HTTP proxy di 127.0.0.1** (`setHttpProxy`) ke app tersebut.
3. Proxy lokal itu (`LocalHttpProxy.kt`) menerima CONNECT/HTTP lalu meneruskan
   semuanya ke **SOCKS5 upstream** dengan auth username/password (`Socks5.kt`).
   Socket ke proxy di-`protect()` supaya tidak balik masuk ke VPN sendiri.
4. Paket lain (UDP/QUIC/DNS langsung) ditangkap route `0.0.0.0/0` lalu dibuang,
   supaya tidak ada trafik yang bocor keluar proxy.

Domain diresolve di sisi proxy (SOCKS5 ATYP=domain), jadi tidak ada DNS leak.

## Build

Butuh Android Studio (paling gampang):

1. Buka Android Studio → **Open** → pilih folder `socks5vpn`.
2. Tunggu Gradle sync (wrapper JAR akan dibuat otomatis oleh Studio).
3. Colok HP (USB debugging ON) → Run, atau **Build > Build APK(s)** untuk file APK.

Kalau punya Gradle CLI:

```
gradle wrapper
./gradlew assembleDebug
```

APK ada di `app/build/outputs/apk/debug/app-debug.apk`.

## Pakai

1. Isi kolom proxy, contoh: `103.12.34.56:1080:userku:passku`
   Tombol **HAPUS** mengosongkan kolom + hapus yang tersimpan, biar gampang tempel proxy baru.
2. Pilih **DNS** (Cloudflare / Google / Quad9 / AdGuard / OpenDNS / Custom).
3. Cari `brave` di kolom pencarian, centang **Brave Browser**.
4. Tekan **CONNECT** → Android minta izin VPN → Allow.
5. Cek di browser: buka `https://ipinfo.io` — IP harus IP proxy.
6. **STOP** dari aplikasi atau dari notifikasi.

Kalau tidak ada app yang dicentang, semua app (kecuali app ini) lewat proxy.

## DNS

Query DNS dari aplikasi terpilih ditangkap dari tun (`DnsForwarder.kt`), lalu dikirim
ke server DNS pilihanmu **lewat SOCKS5** dalam bentuk DNS-over-TCP (RFC 1035).
Jadi DNS ikut jalur proxy, bukan ke ISP. Pilih **Custom** untuk mengisi IP sendiri
(mis. NextDNS `45.90.28.1`).

## Signing

`app/build.gradle.kts` memakai `release.jks` (alias `socks5vpn`, password `socks5vpn`).
Ganti password/keystore-nya kalau APK ini mau dibagikan. `release.jks` sudah masuk
`.gitignore`. Kalau keystore hilang, APK baru tidak bisa jadi update dari yang lama —
harus uninstall dulu.

## Batasan yang perlu diketahui

- Hanya trafik **TCP HTTP/HTTPS** yang jalan. App yang tidak menghormati setelan
  proxy sistem (kebanyakan game, sebagian app yang pakai UDP/QUIC murni) akan
  kehilangan koneksi saat VPN aktif — ini disengaja supaya tidak bocor.
  Browser (Brave/Chrome/Firefox) aman.
- Minimal Android 10 (API 29), karena `setHttpProxy` baru ada di sana.
  Poco X3 GT (MIUI 12.5/13/14) sudah memenuhi.
- MIUI: matikan battery optimization untuk app ini kalau VPN sering diputus.
