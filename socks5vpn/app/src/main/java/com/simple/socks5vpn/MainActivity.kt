package com.simple.socks5vpn

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var etProxy: EditText
    private lateinit var etSearch: EditText
    private lateinit var listApps: ListView
    private lateinit var tvStatus: TextView
    private lateinit var spDns: Spinner
    private lateinit var etCustomDns: EditText
    private var adapter: AppAdapter? = null
    private val selected = HashSet<String>()

    private val vpnPermission =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            if (res.resultCode == RESULT_OK) startVpn()
            else toast("Izin VPN ditolak")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etProxy = findViewById(R.id.etProxy)
        etSearch = findViewById(R.id.etSearch)
        listApps = findViewById(R.id.listApps)
        tvStatus = findViewById(R.id.tvStatus)
        spDns = findViewById(R.id.spDns)
        etCustomDns = findViewById(R.id.etCustomDns)

        etProxy.setText(Prefs.getProxy(this))
        selected.addAll(Prefs.getApps(this))
        setupDns()

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }

        findViewById<Button>(R.id.btnStart).setOnClickListener { onStart2() }
        findViewById<Button>(R.id.btnStop).setOnClickListener { stopVpn() }
        findViewById<Button>(R.id.btnClear).setOnClickListener { clearProxy() }

        etSearch.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                adapter?.filter(s?.toString() ?: "")
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        loadApps()
        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun loadApps() {
        tvStatus.text = "Memuat daftar aplikasi..."
        thread {
            val pm = packageManager
            val items = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                .filter { info ->
                    // hanya app yang butuh internet, dan bukan app ini sendiri
                    info.packageName != packageName &&
                        pm.checkPermission(Manifest.permission.INTERNET, info.packageName) ==
                        PackageManager.PERMISSION_GRANTED
                }
                .map { info: ApplicationInfo ->
                    AppItem(
                        info.packageName,
                        pm.getApplicationLabel(info).toString(),
                        info.loadIcon(pm)
                    )
                }
                .sortedWith(compareBy({ !selected.contains(it.pkg) }, { it.label.lowercase() }))

            runOnUiThread {
                adapter = AppAdapter(this, items, selected)
                listApps.adapter = adapter
                updateStatus()
            }
        }
    }

    /** Kosongkan kolom SOCKS supaya gampang tempel proxy baru. */
    private fun clearProxy() {
        etProxy.setText("")
        Prefs.clearProxy(this)
        etProxy.requestFocus()
        toast("SOCKS dihapus, silakan isi yang baru")
    }

    private fun setupDns() {
        val ad = ArrayAdapter(this, android.R.layout.simple_spinner_item, DnsOption.LIST)
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spDns.adapter = ad

        val saved = Prefs.getDns(this)
        val idx = DnsOption.indexOf(saved)
        spDns.setSelection(idx)
        val isCustom = DnsOption.LIST[idx].ip == DnsOption.CUSTOM
        etCustomDns.visibility = if (isCustom) View.VISIBLE else View.GONE
        if (isCustom) etCustomDns.setText(saved)

        spDns.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                etCustomDns.visibility =
                    if (DnsOption.LIST[pos].ip == DnsOption.CUSTOM) View.VISIBLE else View.GONE
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
    }

    /** IP DNS yang sedang dipilih, null kalau custom-nya tidak valid. */
    private fun currentDns(): String? {
        val opt = DnsOption.LIST[spDns.selectedItemPosition]
        if (opt.ip != DnsOption.CUSTOM) return opt.ip
        val custom = etCustomDns.text.toString().trim()
        return if (DnsOption.isValidIp(custom)) custom else null
    }

    private fun save() {
        Prefs.setProxy(this, etProxy.text.toString())
        Prefs.setApps(this, selected)
        currentDns()?.let { Prefs.setDns(this, it) }
    }

    private fun onStart2() {
        if (currentDns() == null) {
            toast("DNS custom tidak valid. Contoh: 45.90.28.1")
            return
        }
        save()
        if (ProxyConfig.parse(etProxy.text.toString()) == null) {
            toast("Format salah. Contoh: 1.2.3.4:1080:user:pass")
            return
        }
        val intent = VpnService.prepare(this)
        if (intent != null) vpnPermission.launch(intent) else startVpn()
    }

    private fun startVpn() {
        startService(Intent(this, ProxyVpnService::class.java))
        tvStatus.postDelayed({ updateStatus() }, 800)
    }

    private fun stopVpn() {
        startService(Intent(this, ProxyVpnService::class.java).setAction(ProxyVpnService.ACTION_STOP))
        tvStatus.postDelayed({ updateStatus() }, 500)
    }

    private fun updateStatus() {
        val n = selected.size
        val on = if (ProxyVpnService.running) "AKTIF" else "MATI"
        tvStatus.text = "Status: $on  •  Aplikasi dipilih: $n  •  DNS ${Prefs.getDns(this)}"
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_LONG).show()
}
