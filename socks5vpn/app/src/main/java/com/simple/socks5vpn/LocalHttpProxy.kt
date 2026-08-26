package com.simple.socks5vpn

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors

/**
 * HTTP proxy kecil yang hanya listen di 127.0.0.1.
 * Semua koneksi keluar diteruskan ke SOCKS5 upstream.
 * Android VpnService bisa mengumumkan proxy ini ke aplikasi terpilih.
 */
class LocalHttpProxy(
    private val cfg: ProxyConfig,
    private val protect: (Socket) -> Boolean
) {
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()

    @Volatile
    private var running = false

    /** Mulai listen, kembalikan nomor port yang dipakai. */
    @Throws(IOException::class)
    fun start(): Int {
        val ss = ServerSocket(0, 100, InetAddress.getByName("127.0.0.1"))
        server = ss
        running = true
        pool.execute {
            while (running) {
                try {
                    val client = ss.accept()
                    pool.execute { handle(client) }
                } catch (e: IOException) {
                    if (running) Log.w(TAG, "accept: ${e.message}")
                    break
                }
            }
        }
        Log.i(TAG, "Local proxy jalan di 127.0.0.1:${ss.localPort}")
        return ss.localPort
    }

    fun stop() {
        running = false
        try { server?.close() } catch (_: IOException) {}
        pool.shutdownNow()
    }

    private fun handle(client: Socket) {
        var upstream: Socket? = null
        try {
            client.tcpNoDelay = true
            val cin = client.getInputStream()
            val cout = client.getOutputStream()

            val requestLine = readLine(cin) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 3) return
            val method = parts[0]
            val target = parts[1]

            val headers = ArrayList<String>()
            while (true) {
                val h = readLine(cin) ?: break
                if (h.isEmpty()) break
                headers.add(h)
            }

            if (method.equals("CONNECT", true)) {
                // HTTPS / tunnel
                val idx = target.lastIndexOf(':')
                val host = if (idx > 0) target.substring(0, idx) else target
                val port = if (idx > 0) target.substring(idx + 1).toIntOrNull() ?: 443 else 443

                upstream = Socks5.connect(cfg, host, port, protect)
                cout.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
                cout.flush()
            } else {
                // HTTP biasa: ubah absolute-URI jadi origin-form
                val uri = URI(target)
                val host = uri.host ?: return
                val port = if (uri.port > 0) uri.port else 80
                var path = uri.rawPath ?: "/"
                if (path.isEmpty()) path = "/"
                if (uri.rawQuery != null) path += "?" + uri.rawQuery

                upstream = Socks5.connect(cfg, host, port, protect)
                val uout = upstream.getOutputStream()
                val sb = StringBuilder()
                sb.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
                for (h in headers) {
                    val lower = h.lowercase()
                    if (lower.startsWith("proxy-connection:") || lower.startsWith("proxy-authorization:")) continue
                    sb.append(h).append("\r\n")
                }
                sb.append("\r\n")
                uout.write(sb.toString().toByteArray())
                uout.flush()
            }

            val up = upstream ?: return
            val t = Thread { pipe(cin, up.getOutputStream()) }
            t.start()
            pipe(up.getInputStream(), cout)
            t.join(1000)
        } catch (e: Exception) {
            Log.w(TAG, "handle: ${e.message}")
            try {
                client.getOutputStream().write("HTTP/1.1 502 Bad Gateway\r\n\r\n".toByteArray())
            } catch (_: IOException) {}
        } finally {
            try { upstream?.close() } catch (_: IOException) {}
            try { client.close() } catch (_: IOException) {}
        }
    }

    private fun pipe(inp: InputStream, out: OutputStream) {
        val buf = ByteArray(16 * 1024)
        try {
            while (true) {
                val n = inp.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
                out.flush()
            }
        } catch (_: IOException) {
        }
    }

    private fun readLine(inp: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = inp.read()
            if (c == -1) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
            if (sb.length > 8192) return sb.toString()
        }
    }

    companion object {
        private const val TAG = "LocalHttpProxy"
    }
}
