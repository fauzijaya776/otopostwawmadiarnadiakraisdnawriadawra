package com.simple.socks5vpn

/**
 * Format sederhana: host:port  atau  host:port:user:pass
 * Password boleh mengandung ":" karena split dibatasi 4 bagian.
 */
data class ProxyConfig(
    val host: String,
    val port: Int,
    val user: String?,
    val pass: String?
) {
    val hasAuth: Boolean get() = !user.isNullOrEmpty()

    companion object {
        fun parse(raw: String): ProxyConfig? {
            val s = raw.trim()
            if (s.isEmpty()) return null
            val p = s.split(":", limit = 4)
            if (p.size < 2) return null
            val host = p[0].trim()
            val port = p[1].trim().toIntOrNull() ?: return null
            if (host.isEmpty() || port !in 1..65535) return null
            return if (p.size == 4) {
                ProxyConfig(host, port, p[2], p[3])
            } else {
                ProxyConfig(host, port, null, null)
            }
        }
    }
}
