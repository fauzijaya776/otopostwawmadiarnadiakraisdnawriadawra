package com.simple.socks5vpn

/** Daftar DNS siap pakai + opsi custom. */
data class DnsOption(val label: String, val ip: String) {
    override fun toString(): String = label

    companion object {
        const val CUSTOM = ""

        val LIST = listOf(
            DnsOption("Cloudflare — 1.1.1.1", "1.1.1.1"),
            DnsOption("Cloudflare Security (blok malware) — 1.1.1.2", "1.1.1.2"),
            DnsOption("Google — 8.8.8.8", "8.8.8.8"),
            DnsOption("Quad9 (blok malware) — 9.9.9.9", "9.9.9.9"),
            DnsOption("AdGuard (blok iklan) — 94.140.14.14", "94.140.14.14"),
            DnsOption("OpenDNS — 208.67.222.222", "208.67.222.222"),
            DnsOption("Custom (isi sendiri)", CUSTOM)
        )

        val DEFAULT = LIST[0].ip

        /** Index di [LIST] untuk IP tersimpan; kalau tidak cocok -> baris Custom. */
        fun indexOf(ip: String): Int {
            val i = LIST.indexOfFirst { it.ip.isNotEmpty() && it.ip == ip }
            return if (i >= 0) i else LIST.lastIndex
        }

        fun isValidIp(ip: String): Boolean = Socks5.parseIpv4(ip.trim()) != null
    }
}
