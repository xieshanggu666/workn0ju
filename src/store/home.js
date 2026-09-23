import { defineStore } from 'pinia'

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opt)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data
}

export const useHomeStore = defineStore('home', {
  state: () => ({
    loaded: false,
    tab: 'dash',
    rooms: [],
    types: [],
    devices: [],
    scenes: [],
    logs: [],
    energy: { total: 0, trend: [], rooms: [], devices: [] },
    alerts: [],
    quotas: [],
    quotaAlerts: [],
    toast: null,
    timer: null,
    // 已通知过的定额告警 id，轮询发现新增时弹 toast（仅本会话）
    seenQuotaAlertIds: null
  }),
  getters: {
    onlineCount: (s) => s.devices.filter((d) => d.status === 'online').length,
    errorCount: (s) => s.devices.filter((d) => d.status === 'error').length,
    onCount: (s) => s.devices.filter((d) => d.power_on).length,
    totalWatts: (s) => s.devices.reduce((sum, d) => sum + (d.power_on ? d.watts : 0), 0),
    // 待处理/处理中的定额告警，用于 Tab 角标
    pendingQuotaAlerts: (s) => s.quotaAlerts.filter((a) => a.status === 'open' || a.status === 'handling')
  },
  actions: {
    async load() {
      const d = await api('/state')
      const firstLoad = !this.loaded
      this.rooms = d.rooms
      this.types = d.types
      this.devices = d.devices
      this.scenes = d.scenes
      this.logs = d.logs
      this.energy = d.energy
      this.alerts = d.alerts
      this.quotas = d.quotas || []
      this.quotaAlerts = d.quota_alerts || []
      this.loaded = true
      this.notifyNewQuotaAlerts(firstLoad)
    },
    // 新触发（或由预警升级）的定额告警，按创建批次给一次桌面内通知；首次加载不打扰
    notifyNewQuotaAlerts(firstLoad) {
      const active = this.quotaAlerts.filter((a) => a.status === 'open' || a.status === 'handling')
      if (firstLoad) {
        this.seenQuotaAlertIds = new Set(active.map((a) => a.id))
        return
      }
      if (this.seenQuotaAlertIds == null) this.seenQuotaAlertIds = new Set()
      for (const a of active) {
        if (!this.seenQuotaAlertIds.has(a.id)) {
          this.seenQuotaAlertIds.add(a.id)
          const pct = Math.round((a.used_kwh / a.limit_kwh) * 100)
          this.toastMsg(
            `${a.level === 'error' ? '🚨 超标告警' : '⚠️ 超标预警'}：${a.scope === 'room' ? '房间' : '设备'}「${a.target_name}」${a.period_label}定额已用 ${pct}%`,
            a.level === 'error' ? 'warn' : 'info')
        }
      }
    },
    // 看板趋势/实时用电随模拟节拍轻量刷新；轮询失败静默（手动操作仍会立即拉取）
    startAutoRefresh() {
      if (this.timer) return
      this.timer = setInterval(() => { this.load().catch(() => {}) }, 20_000)
    },
    toastMsg(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
    },
    clearToast() { this.toast = null },

    async addDevice(p) {
      try { await api('/device', 'POST', p); await this.load(); this.toastMsg('已新增设备', 'success') }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async removeDevice(id) {
      await api('/device/' + id, 'DELETE'); await this.load()
    },
    async toggleDevice(id) {
      try {
        const r = await api(`/device/${id}/toggle`, 'POST'); await this.load()
        return r.power_on
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async updateDevice(id, patch) {
      await api(`/device/${id}/update`, 'POST', patch); await this.load()
    },
    async addScene(scene) {
      const r = await api('/scene', 'POST', scene); await this.load(); this.toastMsg('场景已创建', 'success'); return r.id
    },
    async deleteScene(id) {
      await api('/scene/' + id, 'DELETE'); await this.load()
    },
    async toggleScene(id) {
      await api(`/scene/${id}/toggle`, 'POST'); await this.load()
    },
    async runScene(id) {
      try {
        const r = await api(`/scene/${id}/run`, 'POST')
        await this.load()
        if (r.failed?.length)
          this.toastMsg(`场景执行完成：成功 ${r.executed.length} 项，失败 ${r.failed.length} 项`, 'warn')
        else
          this.toastMsg(`场景已触发，成功执行 ${r.executed.length} 个动作`, 'success')
        return r
      } catch (e) {
        this.toastMsg(e.message, 'warn')
      }
    },

    // ===== 能耗定额闭环 =====
    async saveQuota(form) {
      try {
        if (form.id) {
          await api(`/quota/${form.id}/update`, 'POST', {
            limit_kwh: Number(form.limit_kwh), period: form.period,
            enabled: form.enabled, reason: form.reason || ''
          })
          this.toastMsg('定额已调整并记录留痕', 'success')
        } else {
          await api('/quota', 'POST', {
            scope: form.scope,
            room_id: form.scope === 'room' ? Number(form.room_id) : null,
            device_id: form.scope === 'device' ? Number(form.device_id) : null,
            period: form.period, limit_kwh: Number(form.limit_kwh),
            reason: form.reason || ''
          })
          this.toastMsg('定额已创建', 'success')
        }
        await this.load()
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async toggleQuota(q) {
      try {
        await api(`/quota/${q.id}/update`, 'POST', { enabled: !q.enabled })
        await this.load()
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async removeQuota(id) {
      await api('/quota/' + id, 'DELETE')
      await this.load()
      this.toastMsg('定额已删除', 'success')
    },
    async handleQuotaAlert(id, patch) {
      try {
        await api(`/quota-alert/${id}/handle`, 'POST', patch)
        await this.load()
        this.toastMsg('告警状态已更新', 'success')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async fetchAdjustments(quotaId = null) {
      const qs = quotaId ? `?quota_id=${quotaId}` : ''
      return await api('/quota-adjustments' + qs)
    }
  }
})
