// ===== 能耗定额与超标预警闭环 =====
// 按「房间」或「设备」配置 日/周/月 周期额度（kWh）。评估器持续把
// energy_records 中已结分段 + energy_segments 中未结运行段（功率×时长实时
// 折算）聚合到当前周期用量，达到额度 80% 触发预警、100% 触发超标告警。
//
// 闭环：同一额度同一周期只保留一条未关闭告警（预警可升级为超标，不重复打扰）；
// 告警保留 待处理→处理中→已处理/已忽略 状态与备注；额度调整留痕可追溯；
// 跨周期旧告警自动结转关闭；额度删除后其未关闭告警自动解除。

const TICK_MS = 30_000          // 与 energy.js 模拟节拍一致：持续聚合、及时触发
const WARN_RATIO = 0.8          // 用量达额度 80% 预警
const MAX_LIVE_MS = 3600_000    // 未结段实时折算最长补 1h（服务重启等场景兜底）

const PERIOD_LABEL = { daily: '每日', weekly: '每周', monthly: '每月' }
const STATUS_LABEL = { open: '待处理', handling: '处理中', resolved: '已处理', ignored: '已忽略' }

let db
let stmts
// 通过注入回调写日志/通知，避免与 index.js 循环依赖
let notify = () => {}
const round4 = (v) => Math.round(v * 10000) / 10000

export function initQuota(database, notifyFn) {
  db = database
  if (typeof notifyFn === 'function') notify = notifyFn
  db.exec(`
  CREATE TABLE IF NOT EXISTS energy_quotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,               -- room / device
    room_id INTEGER,                   -- scope=room 时指向 rooms.id
    device_id INTEGER,                 -- scope=device 时的稳定标识（不设级联：设备删除后历史保留）
    target_name TEXT NOT NULL,         -- 房间名/设备名快照（设备删除后仍可展示）
    period TEXT NOT NULL,              -- daily / weekly / monthly
    limit_kwh REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_energy_quotas_scope ON energy_quotas(scope);
  CREATE TABLE IF NOT EXISTS quota_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,         -- 额度删除不级联，告警按快照保留
    scope TEXT NOT NULL,
    target_name TEXT NOT NULL,
    period TEXT NOT NULL,
    period_start TEXT NOT NULL,       -- 告警所属周期起点，周期粒度去重/结转依据
    period_end TEXT NOT NULL,
    level TEXT NOT NULL,              -- warn(80%) / error(100%)
    used_kwh REAL NOT NULL,
    limit_kwh REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open / handling / resolved / ignored
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    handled_at TEXT,
    UNIQUE(quota_id, period_start)
  );
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_status ON quota_alerts(status);
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_quota ON quota_alerts(quota_id);
  CREATE TABLE IF NOT EXISTS quota_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,
    action TEXT NOT NULL,             -- create / update / enable / disable / delete
    old_limit REAL,
    new_limit REAL,
    old_period TEXT,
    new_period TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quota_adjustments_quota ON quota_adjustments(quota_id);
  `)
  stmts = {
    allQuotas: db.prepare('SELECT * FROM energy_quotas ORDER BY id'),
    quotaById: db.prepare('SELECT * FROM energy_quotas WHERE id=?'),
    roomName: db.prepare('SELECT name FROM rooms WHERE id=?'),
    insertQuota: db.prepare(`INSERT INTO energy_quotas
      (scope,room_id,device_id,target_name,period,limit_kwh,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    updateQuota: db.prepare('UPDATE energy_quotas SET limit_kwh=?,period=?,enabled=?,updated_at=? WHERE id=?'),
    deleteQuota: db.prepare('DELETE FROM energy_quotas WHERE id=?'),
    insertAdj: db.prepare(`INSERT INTO quota_adjustments
      (quota_id,action,old_limit,new_limit,old_period,new_period,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?)`),
    adjByQuota: db.prepare('SELECT * FROM quota_adjustments WHERE quota_id=? ORDER BY id DESC LIMIT 30'),
    allAdj: db.prepare(`SELECT a.*, q.scope, q.target_name FROM quota_adjustments a
                        LEFT JOIN energy_quotas q ON q.id=a.quota_id
                        ORDER BY a.id DESC LIMIT 50`),
    recRoom: db.prepare('SELECT COALESCE(SUM(kwh),0) v FROM energy_records WHERE room=? AND end_time>=?'),
    recDevice: db.prepare('SELECT COALESCE(SUM(kwh),0) v FROM energy_records WHERE device_id=? AND end_time>=?'),
    segRoom: db.prepare('SELECT * FROM energy_segments WHERE room=?'),
    segDevice: db.prepare('SELECT * FROM energy_segments WHERE device_id=?'),
    activeAlert: db.prepare('SELECT * FROM quota_alerts WHERE quota_id=? AND period_start=?'),
    insertAlert: db.prepare(`INSERT INTO quota_alerts
      (quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`),
    raiseAlert: db.prepare('UPDATE quota_alerts SET level=?,used_kwh=?,limit_kwh=?,updated_at=? WHERE id=?'),
    touchAlert: db.prepare('UPDATE quota_alerts SET used_kwh=?,updated_at=? WHERE id=?'),
    openAlerts: db.prepare("SELECT * FROM quota_alerts WHERE status IN ('open','handling')"),
    staleByQuota: db.prepare("SELECT * FROM quota_alerts WHERE quota_id=? AND status IN ('open','handling') AND period_start<>?"),
    closeAlert: db.prepare('UPDATE quota_alerts SET status=?,note=?,handled_at=?,updated_at=? WHERE id=?')
  }

  seedQuotas()
  // 首次启动播种后立即评估一次，让看板开箱即有闭环演示数据
  evaluateAll(new Date())
  setInterval(() => { try { evaluateAll(new Date()) } catch (e) { console.error('[QUOTA] tick error', e) } }, TICK_MS)
}

// ===== 周期窗口 =====
export function periodRange(period, at = new Date()) {
  const end = new Date(at)
  const start = new Date(at)
  if (period === 'daily') {
    start.setHours(0, 0, 0, 0)
    end.setHours(24, 0, 0, 0)
  } else if (period === 'weekly') {
    // 周一为一周起点
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    end.setTime(start.getTime())
    end.setDate(end.getDate() + 7)
  } else {
    start.setHours(0, 0, 0, 0)
    start.setDate(1)
    end.setTime(start.getTime())
    end.setMonth(end.getMonth() + 1)
  }
  return { start, end }
}

// 当前周期已用电量 = 已结分段 + 未结运行段实时折算（功率×已运行时长）
function computeUsage(quota, at = new Date()) {
  const { start } = periodRange(quota.period, at)
  const sinceIso = start.toISOString()
  let v = quota.scope === 'room'
    ? stmts.recRoom.get(quota.target_name, sinceIso).v
    : stmts.recDevice.get(quota.device_id, sinceIso).v
  const segs = quota.scope === 'room'
    ? stmts.segRoom.all(quota.target_name)
    : stmts.segDevice.all(quota.device_id)
  for (const s of segs) {
    const segStart = Math.max(new Date(s.start_time).getTime(), start.getTime())
    const dur = Math.min(at.getTime() - segStart, MAX_LIVE_MS)
    if (dur > 0) v += (s.watts * dur) / 3_600_000_000
  }
  return round4(v)
}

// ===== 核心评估：全量额度聚合 → 触发/升级/更新告警；跨周期与已删额度结转 =====
export function evaluateAll(at = new Date()) {
  const quotas = stmts.allQuotas.all()
  const liveQuotaIds = new Set(quotas.map((q) => q.id))
  let changed = false

  for (const q of quotas) {
    if (!q.enabled) continue
    const { start, end } = periodRange(q.period, at)
    // 跨周期：上一周期仍未关闭的告警自动结转（关闭），新周期重新评估
    for (const old of stmts.staleByQuota.all(q.id, start.toISOString())) {
      stmts.closeAlert.run('ignored', appendNote(old.note, '周期结束自动结转关闭'), at.toISOString(), at.toISOString(), old.id)
      changed = true
    }

    const used = computeUsage(q, at)
    const ratio = used / q.limit_kwh
    const level = ratio >= 1 ? 'error' : ratio >= WARN_RATIO ? 'warn' : null
    const alert = stmts.activeAlert.get(q.id, start.toISOString())

    if (level && !alert) {
      stmts.insertAlert.run(q.id, q.scope, q.target_name, q.period,
        start.toISOString(), end.toISOString(), level, used, q.limit_kwh,
        at.toISOString(), at.toISOString())
      notify(buildAlertLog(q, level, used), at.toLocaleString('zh-CN'))
      changed = true
    } else if (alert && level === 'error' && alert.level === 'warn'
               && alert.status !== 'resolved' && alert.status !== 'ignored') {
      // 预警升级为超标
      stmts.raiseAlert.run('error', used, q.limit_kwh, at.toISOString(), alert.id)
      notify(buildAlertLog(q, 'error', used), at.toLocaleString('zh-CN'))
      changed = true
    } else if (alert && Math.abs(alert.used_kwh - used) >= 0.0001) {
      // 用量持续变化：同步最新用量（已处理/已忽略的告警只更新读数，不复活状态）
      stmts.touchAlert.run(used, at.toISOString(), alert.id)
      changed = true
    }
  }

  // 额度已删除：残留未关闭告警自动解除
  for (const a of stmts.openAlerts.all()) {
    if (!liveQuotaIds.has(a.quota_id)) {
      stmts.closeAlert.run('ignored', appendNote(a.note, '定额已删除，告警自动解除'),
        at.toISOString(), at.toISOString(), a.id)
      changed = true
    }
  }
  return changed
}

function appendNote(note, text) {
  return note ? `${note} ｜ ${text}` : text
}

function buildAlertLog(q, level, used) {
  const tag = level === 'error' ? '超标告警' : '超标预警'
  return {
    device: level === 'error' ? '🚨' : '⚠️',
    action: `能耗${tag}`,
    detail: `${q.scope === 'room' ? '房间' : '设备'}「${q.target_name}」${PERIOD_LABEL[q.period]}定额 ${q.limit_kwh}kWh，当前已用 ${used.toFixed(2)}kWh（${Math.round((used / q.limit_kwh) * 100)}%）`
  }
}

// ===== 额度增改删（均留痕） =====
function snapshotName(scope, roomId, deviceId) {
  if (scope === 'room') {
    const r = stmts.roomName.get(roomId)
    if (!r) throw new Error('房间不存在')
    return r.name
  }
  const d = db.prepare('SELECT d.name FROM devices d WHERE d.id=?').get(deviceId)
  if (!d) throw new Error('设备不存在')
  return d.name
}

export function createQuota({ scope, room_id, device_id, period, limit_kwh, reason = '' }) {
  if (!['room', 'device'].includes(scope)) throw new Error('定额对象类型无效')
  if (!['daily', 'weekly', 'monthly'].includes(period)) throw new Error('周期无效')
  const limit = Number(limit_kwh)
  if (!Number.isFinite(limit) || limit <= 0 || limit > 100000) throw new Error('额度需为 0-100000 的正数(kWh)')
  const roomId = scope === 'room' ? Number(room_id) : null
  const deviceId = scope === 'device' ? Number(device_id) : null
  const targetName = snapshotName(scope, roomId, deviceId)

  // 同一对象 + 同一周期只允许一条有效额度，避免重复告警
  const dup = db.prepare('SELECT id FROM energy_quotas WHERE scope=? AND period=? AND COALESCE(room_id,-1)=COALESCE(?,-1) AND COALESCE(device_id,-1)=COALESCE(?,-1)')
    .get(scope, period, roomId, deviceId)
  if (dup) throw new Error('该对象在此周期下已有定额，请直接编辑原额度')

  const at = new Date()
  const r = stmts.insertQuota.run(scope, roomId, deviceId, targetName, period, round4(limit), 1,
    at.toISOString(), at.toISOString())
  stmts.insertAdj.run(r.lastInsertRowid, 'create', null, round4(limit), null, period, reason, at.toISOString())
  evaluateAll(at)
  return r.lastInsertRowid
}

export function updateQuota(id, { limit_kwh, period, enabled, reason = '' }) {
  const q = stmts.quotaById.get(id)
  if (!q) throw new Error('定额不存在')
  const at = new Date()
  const nextLimit = limit_kwh != null ? Number(limit_kwh) : q.limit_kwh
  const nextPeriod = period ?? q.period
  const nextEnabled = enabled != null ? (enabled ? 1 : 0) : q.enabled
  if (!Number.isFinite(nextLimit) || nextLimit <= 0 || nextLimit > 100000) throw new Error('额度需为 0-100000 的正数(kWh)')
  if (!['daily', 'weekly', 'monthly'].includes(nextPeriod)) throw new Error('周期无效')

  // 换周期若与已有额度撞车则拒绝（同一对象+周期唯一）
  if (nextPeriod !== q.period) {
    const dup = db.prepare('SELECT id FROM energy_quotas WHERE id<>? AND scope=? AND period=? AND COALESCE(room_id,-1)=COALESCE(?,-1) AND COALESCE(device_id,-1)=COALESCE(?,-1)')
      .get(id, q.scope, nextPeriod, q.room_id, q.device_id)
    if (dup) throw new Error('该对象在此周期下已有定额，无法切换周期')
  }

  const changes = []
  if (nextLimit !== q.limit_kwh) changes.push(`额度 ${q.limit_kwh}→${round4(nextLimit)}kWh`)
  if (nextPeriod !== q.period) changes.push(`周期 ${PERIOD_LABEL[q.period]}→${PERIOD_LABEL[nextPeriod]}`)
  if (nextEnabled !== q.enabled) changes.push(nextEnabled ? '已启用' : '已停用')
  stmts.updateQuota.run(round4(nextLimit), nextPeriod, nextEnabled, at.toISOString(), id)
  stmts.insertAdj.run(id, nextEnabled !== q.enabled ? (nextEnabled ? 'enable' : 'disable') : 'update',
    q.limit_kwh, round4(nextLimit), q.period, nextPeriod,
    reason || changes.join('，'), at.toISOString())
  evaluateAll(at)
  return changes
}

export function deleteQuota(id, reason = '') {
  const q = stmts.quotaById.get(id)
  if (!q) throw new Error('定额不存在')
  const at = new Date()
  stmts.insertAdj.run(id, 'delete', q.limit_kwh, null, q.period, null, reason, at.toISOString())
  stmts.deleteQuota.run(id)
  // 立即解除其未关闭告警
  evaluateAll(at)
}

// ===== 告警处理闭环 =====
export function handleAlert(id, { status, note }) {
  const a = db.prepare('SELECT * FROM quota_alerts WHERE id=?').get(id)
  if (!a) throw new Error('告警不存在')
  if (!['open', 'handling', 'resolved', 'ignored'].includes(status)) throw new Error('处理状态无效')
  const at = new Date()
  const nextNote = note != null ? String(note) : a.note
  const handled = status === 'resolved' || status === 'ignored'
    ? (a.handled_at || at.toISOString())
    : null
  db.prepare('UPDATE quota_alerts SET status=?,note=?,handled_at=?,updated_at=? WHERE id=?')
    .run(status, nextNote, handled, at.toISOString(), id)
  return { status, note: nextNote }
}

// ===== 给 /api/state 的序列化视图 =====
export function listQuotas(at = new Date()) {
  return stmts.allQuotas.all().map((q) => {
    const { start, end } = periodRange(q.period, at)
    const used = q.enabled ? computeUsage(q, at) : 0
    const alert = stmts.activeAlert.get(q.id, start.toISOString())
    const ratio = q.limit_kwh > 0 ? used / q.limit_kwh : 0
    return {
      id: q.id,
      scope: q.scope,
      room_id: q.room_id,
      device_id: q.device_id,
      target_name: q.target_name,
      period: q.period,
      period_label: PERIOD_LABEL[q.period],
      limit_kwh: q.limit_kwh,
      enabled: !!q.enabled,
      used_kwh: used,
      ratio: Math.round(ratio * 1000) / 10,           // 百分比，保留 1 位
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      device_deleted: q.scope === 'device'
        && !db.prepare('SELECT id FROM devices WHERE id=?').get(q.device_id),
      alert: alert ? {
        id: alert.id, level: alert.level, status: alert.status,
        status_label: STATUS_LABEL[alert.status],
        used_kwh: alert.used_kwh, note: alert.note
      } : null
    }
  })
}

export function listAlerts(at = new Date()) {
  return db.prepare('SELECT * FROM quota_alerts ORDER BY id DESC LIMIT 100').all().map((a) => ({
    id: a.id,
    quota_id: a.quota_id,
    scope: a.scope,
    target_name: a.target_name,
    period: a.period,
    period_label: PERIOD_LABEL[a.period],
    period_start: a.period_start,
    period_end: a.period_end,
    level: a.level,
    used_kwh: a.used_kwh,
    limit_kwh: a.limit_kwh,
    status: a.status,
    status_label: STATUS_LABEL[a.status],
    note: a.note,
    created_at: a.created_at,
    updated_at: a.updated_at,
    handled_at: a.handled_at
  }))
}

export function getAdjustments(quotaId = null) {
  const rows = quotaId ? stmts.adjByQuota.all(quotaId) : stmts.allAdj.all()
  return rows.map((a) => ({
    id: a.id,
    quota_id: a.quota_id,
    scope: a.scope || null,
    target_name: a.target_name || null,
    action: a.action,
    old_limit: a.old_limit,
    new_limit: a.new_limit,
    old_period: a.old_period,
    new_period: a.new_period,
    reason: a.reason,
    created_at: a.created_at
  }))
}

export function activeAlertCount() {
  return db.prepare("SELECT COUNT(*) c FROM quota_alerts WHERE status IN ('open','handling')").get().c
}

// ===== 首次启动演示定额：按「当前周期真实用量」反推额度，保证开箱即触发闭环 =====
function seedQuotas() {
  if (stmts.allQuotas.all().length > 0) return
  const at = new Date()
  // 构造临时额度对象，复用同一套周期聚合口径，避免与实际评估窗口不一致
  const usedOf = (scope, period, roomId, deviceId) => {
    const targetName = scope === 'room' ? stmts.roomName.get(roomId)?.name : null
    return computeUsage({ scope, period, room_id: roomId, device_id: deviceId, target_name: targetName }, at)
  }

  const seeds = []
  // 房间·每日：客厅，额度卡在 80%~100% 之间 → 预警
  const living = stmts.roomName.get(1)
  if (living) {
    const used = usedOf('room', 'daily', 1, null)
    if (used > 0.05) seeds.push({ scope: 'room', room_id: 1, device_id: null, period: 'daily', limit_kwh: round4(used / 0.9), reason: '初始演示额度' })
  }
  // 设备·每日：空调，额度卡在已用量之下 → 直接超标
  const ac = db.prepare("SELECT d.id FROM devices d WHERE d.name LIKE '%空调%' AND d.watts>=1000 ORDER BY d.id LIMIT 1").get()
  if (ac) {
    const used = usedOf('device', 'daily', null, ac.id)
    if (used > 0.05) seeds.push({ scope: 'device', room_id: null, device_id: ac.id, period: 'daily', limit_kwh: round4(used / 1.25), reason: '初始演示额度' })
  }
  // 房间·每周：厨房，额度放宽 → 正常，演示进度条
  const kitchen = stmts.roomName.get(3)
  if (kitchen) {
    const used = usedOf('room', 'weekly', 3, null)
    if (used > 0.01) seeds.push({ scope: 'room', room_id: 3, device_id: null, period: 'weekly', limit_kwh: round4(Math.max(used * 5, 10)), reason: '初始演示额度' })
  }
  // 设备·每月：高功率插座
  const socket = db.prepare("SELECT d.id FROM devices d WHERE d.type_id=6 AND d.watts>=150 ORDER BY d.id LIMIT 1").get()
  if (socket) {
    const used = usedOf('device', 'monthly', null, socket.id)
    if (used > 0.01) seeds.push({ scope: 'device', room_id: null, device_id: socket.id, period: 'monthly', limit_kwh: round4(Math.max(used * 8, 20)), reason: '初始演示额度' })
  }

  for (const s of seeds) {
    try {
      createQuota(s)
    } catch (e) {
      // 演示数据冲突（如重复播种）不阻断启动
      console.warn('[QUOTA] seed skip:', e.message)
    }
  }
}
