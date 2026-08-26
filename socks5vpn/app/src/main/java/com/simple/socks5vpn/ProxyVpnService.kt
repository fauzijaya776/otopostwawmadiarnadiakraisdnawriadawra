package com.simple.socks5vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.ProxyInfo
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import android.widget.Toast
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

class ProxyVpnService : VpnService() {

    private var tun: ParcelFileDescriptor? = null
    private var proxy: LocalHttpProxy? = null
    private var dns: DnsForwarder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopVpn()
            return START_NOT_STICKY
        }
        startVpn()
        return START_STICKY
    }

    private fun startVpn() {
        val cfg = ProxyConfig.parse(Prefs.getProxy(this))
        if (cfg == null) {
            toast("Format proxy salah. Pakai host:port:user:pass")
            stopSelf()
            return
        }

        try {
            val p = LocalHttpProxy(cfg) { s -> protect(s) }
            val localPort = p.start()
            proxy = p

            val dnsServer = Prefs.getDns(this)

            val b = Builder()
                .setSession("SOCKS5 VPN")
                .setMtu(1500)
                .addAddress("10.10.10.2", 32)
                .addRoute("0.0.0.0", 0)          // tangkap semua, sisanya dibuang (anti bocor)
                .addDnsServer(dnsServer)
                .setHttpProxy(ProxyInfo.buildDirectProxy("127.0.0.1", localPort))

            val selected = Prefs.getApps(this)
            if (selected.isEmpty()) {
                // Tidak ada pilihan: semua app kecuali app ini sendiri
                b.addDisallowedApplication(packageName)
            } else {
                var added = 0
                for (pkg in selected) {
                    if (pkg == packageName) continue
                    try {
                        b.addAllowedApplication(pkg)
                        added++
                    } catch (e: Exception) {
                        Log.w(TAG, "Paket tidak ada: $pkg")
                    }
                }
                if (added == 0) {
                    toast("Aplikasi yang dipilih tidak ditemukan")
                    stopVpn()
                    return
                }
            }

            tun = b.establish()
            if (tun == null) {
                toast("Gagal membuat VPN (izin belum diberikan?)")
                stopVpn()
                return
            }

            startForeground(NOTIF_ID, buildNotification(cfg, dnsServer))
            running = true

            val pfd = tun!!
            dns = DnsForwarder(
                FileInputStream(pfd.fileDescriptor),
                FileOutputStream(pfd.fileDescriptor),
                cfg,
                dnsServer
            ) { s -> protect(s) }.also { it.start() }

            toast("Proxy aktif: ${cfg.host}:${cfg.port} • DNS $dnsServer")
        } catch (e: Exception) {
            Log.e(TAG, "startVpn", e)
            toast("Gagal: ${e.message}")
            stopVpn()
        }
    }

    private fun stopVpn() {
        running = false
        try { tun?.close() } catch (_: IOException) {}
        tun = null
        proxy?.stop()
        proxy = null
        dns?.stop()
        dns = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    override fun onRevoke() {
        stopVpn()
        super.onRevoke()
    }

    private fun buildNotification(cfg: ProxyConfig, dnsServer: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL, "Status VPN", NotificationManager.IMPORTANCE_LOW)
        nm.createNotificationChannel(ch)

        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, ProxyVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, CHANNEL)
            .setContentTitle("SOCKS5 aktif")
            .setContentText("${cfg.host}:${cfg.port}  •  DNS $dnsServer")
            .setSmallIcon(R.drawable.ic_stat_vpn)
            .setContentIntent(openIntent)
            .addAction(
                Notification.Action.Builder(null, "Stop", stopIntent).build()
            )
            .setOngoing(true)
            .build()
    }

    private fun toast(msg: String) {
        android.os.Handler(mainLooper).post {
            Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        private const val TAG = "ProxyVpnService"
        private const val CHANNEL = "vpn_status"
        private const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.simple.socks5vpn.STOP"

        @Volatile
        var running = false
            private set
    }
}
