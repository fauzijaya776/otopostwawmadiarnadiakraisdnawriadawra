package com.simple.socks5vpn

import android.content.Context
import android.graphics.drawable.Drawable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.TextView

data class AppItem(val pkg: String, val label: String, val icon: Drawable)

class AppAdapter(
    private val ctx: Context,
    private val all: List<AppItem>,
    private val selected: MutableSet<String>
) : BaseAdapter() {

    private var shown: List<AppItem> = all

    fun filter(q: String) {
        val s = q.trim().lowercase()
        shown = if (s.isEmpty()) all
        else all.filter { it.label.lowercase().contains(s) || it.pkg.lowercase().contains(s) }
        notifyDataSetChanged()
    }

    override fun getCount() = shown.size
    override fun getItem(position: Int) = shown[position]
    override fun getItemId(position: Int) = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val v = convertView ?: LayoutInflater.from(ctx).inflate(R.layout.item_app, parent, false)
        val item = shown[position]
        v.findViewById<ImageView>(R.id.icon).setImageDrawable(item.icon)
        v.findViewById<TextView>(R.id.label).text = item.label
        v.findViewById<TextView>(R.id.pkg).text = item.pkg
        val cb = v.findViewById<CheckBox>(R.id.check)
        cb.setOnCheckedChangeListener(null)
        cb.isChecked = selected.contains(item.pkg)
        cb.setOnCheckedChangeListener { _, checked ->
            if (checked) selected.add(item.pkg) else selected.remove(item.pkg)
        }
        v.setOnClickListener { cb.isChecked = !cb.isChecked }
        return v
    }
}
