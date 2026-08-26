package com.simple.socks5vpn

import android.content.Context

object Prefs {
    private const val FILE = "socks5vpn"
    private const val KEY_PROXY = "proxy"
    private const val KEY_APPS = "apps"
    private const val KEY_DNS = "dns"

    private fun sp(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun getProxy(c: Context): String = sp(c).getString(KEY_PROXY, "") ?: ""

    fun setProxy(c: Context, v: String) {
        sp(c).edit().putString(KEY_PROXY, v.trim()).apply()
    }

    fun getApps(c: Context): MutableSet<String> =
        HashSet(sp(c).getStringSet(KEY_APPS, emptySet()) ?: emptySet())

    fun setApps(c: Context, v: Set<String>) {
        sp(c).edit().putStringSet(KEY_APPS, HashSet(v)).apply()
    }

    fun getDns(c: Context): String {
        val v = sp(c).getString(KEY_DNS, DnsOption.DEFAULT) ?: DnsOption.DEFAULT
        return if (v.isBlank()) DnsOption.DEFAULT else v
    }

    fun setDns(c: Context, v: String) {
        sp(c).edit().putString(KEY_DNS, v.trim()).apply()
    }

    /** Kosongkan SOCKS yang tersimpan (tombol Hapus). */
    fun clearProxy(c: Context) {
        sp(c).edit().remove(KEY_PROXY).apply()
    }
}
