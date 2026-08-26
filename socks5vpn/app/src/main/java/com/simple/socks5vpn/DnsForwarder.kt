package com.simple.socks5vpn

import android.util.Log
import java.io.DataInputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.Socket
import java.util.concurrent.Executors

/**
 * Membaca paket dari tun.
 * - UDP port 53  -> diteruskan ke DNS pilihan LEWAT SOCKS5 (DNS-over-TCP), balasan
 *   ditulis balik ke tun. Jadi DNS ikut proxy, tidak bocor ke ISP.
 * - Paket lain   -> dibuang (biar tidak ada trafik yang lolos di luar proxy).
 */
class DnsForwarder(
    private val tunIn: FileInputStream,
    private val tunOut: FileOutputStream,
    private val cfg: ProxyConfig,
    private val dnsServer: String,
    private val protect: (Socket) -> Boolean
) {
    private val pool = Executors.newFixedThreadPool(8)
    private val writeLock = Any()

    @Volatile
    private var running = false

    fun start() {
        running = true
        Thread({ loop() }, "tun-reader").start()
    }

    fun stop() {
        running = false
        pool.shutdownNow()
    }

    private fun loop() {
        val buf = ByteArray(32767)
        try {
            while (running) {
                val n = tunIn.read(buf)
                if (n < 0) break
                if (n == 0) continue
                val pkt = buf.copyOf(n)
                if (isDnsQuery(pkt)) {
                    try {
                        pool.execute { forward(pkt) }
                    } catch (_: Exception) {
                        // pool penuh / sudah shutdown -> paket dibuang saja
                    }
                }
                // selain DNS: dibuang
            }
        } catch (_: IOException) {
        }
    }

    private fun isDnsQuery(p: ByteArray): Boolean {
        if (p.size < 28) return false
        if ((p[0].toInt() shr 4) and 0x0F != 4) return false      // hanya IPv4
        val ihl = (p[0].toInt() and 0x0F) * 4
        if (ihl < 20 || p.size < ihl + 8) return false
        if ((p[9].toInt() and 0xFF) != 17) return false           // hanya UDP
        val dstPort = ((p[ihl + 2].toInt() and 0xFF) shl 8) or (p[ihl + 3].toInt() and 0xFF)
        return dstPort == 53
    }

    private fun forward(p: ByteArray) {
        val ihl = (p[0].toInt() and 0x0F) * 4
        val srcIp = p.copyOfRange(12, 16)
        val dstIp = p.copyOfRange(16, 20)
        val srcPort = ((p[ihl].toInt() and 0xFF) shl 8) or (p[ihl + 1].toInt() and 0xFF)
        val udpLen = ((p[ihl + 4].toInt() and 0xFF) shl 8) or (p[ihl + 5].toInt() and 0xFF)
        val payloadLen = (udpLen - 8).coerceAtMost(p.size - ihl - 8)
        if (payloadLen <= 0) return
        val query = p.copyOfRange(ihl + 8, ihl + 8 + payloadLen)

        var s: Socket? = null
        try {
            s = Socks5.connect(cfg, dnsServer, 53, protect)
            s.soTimeout = 8000
            val o = s.getOutputStream()
            // DNS over TCP: 2 byte panjang di depan (RFC 1035)
            o.write(byteArrayOf(((query.size shr 8) and 0xFF).toByte(), (query.size and 0xFF).toByte()))
            o.write(query)
            o.flush()

            val din = DataInputStream(s.getInputStream())
            val len = ((din.readByte().toInt() and 0xFF) shl 8) or (din.readByte().toInt() and 0xFF)
            if (len <= 0 || len > 8192) return
            val answer = ByteArray(len)
            din.readFully(answer)

            // balikkan: sumber = server DNS, tujuan = aplikasi
            val reply = buildUdpPacket(dstIp, 53, srcIp, srcPort, answer)
            synchronized(writeLock) {
                tunOut.write(reply)
                tunOut.flush()
            }
        } catch (e: Exception) {
            Log.w(TAG, "DNS gagal: ${e.message}")
        } finally {
            try { s?.close() } catch (_: IOException) {}
        }
    }

    private fun buildUdpPacket(
        srcIp: ByteArray, srcPort: Int,
        dstIp: ByteArray, dstPort: Int,
        payload: ByteArray
    ): ByteArray {
        val total = 20 + 8 + payload.size
        val p = ByteArray(total)
        p[0] = 0x45                                   // IPv4, IHL=5
        p[1] = 0
        p[2] = ((total shr 8) and 0xFF).toByte()
        p[3] = (total and 0xFF).toByte()
        p[4] = 0; p[5] = 0                            // identification
        p[6] = 0x40; p[7] = 0                         // don't fragment
        p[8] = 64                                     // TTL
        p[9] = 17                                     // UDP
        System.arraycopy(srcIp, 0, p, 12, 4)
        System.arraycopy(dstIp, 0, p, 16, 4)
        val ck = checksum(p, 0, 20)
        p[10] = ((ck shr 8) and 0xFF).toByte()
        p[11] = (ck and 0xFF).toByte()

        var i = 20
        p[i++] = ((srcPort shr 8) and 0xFF).toByte()
        p[i++] = (srcPort and 0xFF).toByte()
        p[i++] = ((dstPort shr 8) and 0xFF).toByte()
        p[i++] = (dstPort and 0xFF).toByte()
        val ul = 8 + payload.size
        p[i++] = ((ul shr 8) and 0xFF).toByte()
        p[i++] = (ul and 0xFF).toByte()
        p[i++] = 0; p[i] = 0                          // checksum UDP boleh 0 di IPv4
        System.arraycopy(payload, 0, p, 28, payload.size)
        return p
    }

    private fun checksum(b: ByteArray, off: Int, len: Int): Int {
        var sum = 0
        var i = off
        while (i < off + len - 1) {
            sum += ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)
            i += 2
        }
        if (len % 2 == 1) sum += (b[off + len - 1].toInt() and 0xFF) shl 8
        while ((sum shr 16) != 0) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv() and 0xFFFF
    }

    companion object {
        private const val TAG = "DnsForwarder"
    }
}
