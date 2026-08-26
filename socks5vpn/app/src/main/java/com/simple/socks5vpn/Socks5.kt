package com.simple.socks5vpn

import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** Klien SOCKS5 minimal (CONNECT + auth username/password RFC 1929). */
object Socks5 {

    /**
     * Buka koneksi ke destHost:destPort lewat SOCKS5.
     * [protect] dipakai untuk VpnService.protect() supaya socket ke proxy
     * tidak ikut masuk ke tunnel VPN (kalau tidak, jadi loop).
     */
    @Throws(IOException::class)
    fun connect(
        cfg: ProxyConfig,
        destHost: String,
        destPort: Int,
        protect: (Socket) -> Boolean
    ): Socket {
        val s = Socket()
        try {
            s.tcpNoDelay = true
            protect(s)
            s.connect(InetSocketAddress(cfg.host, cfg.port), 15000)
            s.soTimeout = 30000

            val out: OutputStream = s.getOutputStream()
            val inp = DataInputStream(s.getInputStream())

            // 1. Greeting
            if (cfg.hasAuth) {
                out.write(byteArrayOf(0x05, 0x02, 0x00, 0x02))
            } else {
                out.write(byteArrayOf(0x05, 0x01, 0x00))
            }
            out.flush()

            val ver = inp.readByte().toInt() and 0xFF
            val method = inp.readByte().toInt() and 0xFF
            if (ver != 0x05) throw IOException("Bukan server SOCKS5 (ver=$ver)")

            // 2. Auth kalau diminta
            when (method) {
                0x00 -> {}
                0x02 -> {
                    if (!cfg.hasAuth) throw IOException("Proxy minta username/password")
                    val u = (cfg.user ?: "").toByteArray()
                    val p = (cfg.pass ?: "").toByteArray()
                    val buf = ByteArray(3 + u.size + p.size)
                    var i = 0
                    buf[i++] = 0x01
                    buf[i++] = u.size.toByte()
                    System.arraycopy(u, 0, buf, i, u.size); i += u.size
                    buf[i++] = p.size.toByte()
                    System.arraycopy(p, 0, buf, i, p.size)
                    out.write(buf)
                    out.flush()
                    inp.readByte() // versi auth
                    val status = inp.readByte().toInt() and 0xFF
                    if (status != 0x00) throw IOException("Username/password proxy ditolak")
                }
                0xFF -> throw IOException("Proxy menolak semua metode auth")
                else -> throw IOException("Metode auth tidak didukung: $method")
            }

            // 3. CONNECT. Kalau tujuan berupa IPv4 literal dikirim sebagai ATYP=1,
            //    selain itu sebagai nama domain supaya DNS diresolve di sisi proxy.
            val ipv4 = parseIpv4(destHost)
            val req: ByteArray
            var i = 0
            if (ipv4 != null) {
                req = ByteArray(10)
                req[i++] = 0x05; req[i++] = 0x01; req[i++] = 0x00; req[i++] = 0x01
                System.arraycopy(ipv4, 0, req, i, 4); i += 4
            } else {
                val hostBytes = destHost.toByteArray()
                req = ByteArray(7 + hostBytes.size)
                req[i++] = 0x05; req[i++] = 0x01; req[i++] = 0x00; req[i++] = 0x03
                req[i++] = hostBytes.size.toByte()
                System.arraycopy(hostBytes, 0, req, i, hostBytes.size); i += hostBytes.size
            }
            req[i++] = ((destPort shr 8) and 0xFF).toByte()
            req[i] = (destPort and 0xFF).toByte()
            out.write(req)
            out.flush()

            // 4. Balasan
            inp.readByte() // ver
            val rep = inp.readByte().toInt() and 0xFF
            inp.readByte() // rsv
            val atyp = inp.readByte().toInt() and 0xFF
            when (atyp) {
                0x01 -> inp.skipFully(4)
                0x03 -> inp.skipFully((inp.readByte().toInt() and 0xFF))
                0x04 -> inp.skipFully(16)
                else -> throw IOException("ATYP balasan tidak dikenal: $atyp")
            }
            inp.skipFully(2) // port
            if (rep != 0x00) throw IOException("SOCKS5 gagal connect (kode $rep)")

            s.soTimeout = 0
            return s
        } catch (e: IOException) {
            try { s.close() } catch (_: IOException) {}
            throw e
        }
    }

    /** Kembalikan 4 byte kalau [h] memang IPv4 literal, null kalau nama domain. */
    fun parseIpv4(h: String): ByteArray? {
        val parts = h.split(".")
        if (parts.size != 4) return null
        val b = ByteArray(4)
        for (j in 0..3) {
            val v = parts[j].toIntOrNull() ?: return null
            if (v !in 0..255) return null
            b[j] = v.toByte()
        }
        return b
    }

    private fun DataInputStream.skipFully(n: Int) {
        val b = ByteArray(n)
        readFully(b)
    }
}
