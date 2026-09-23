// 端到端验证：真实 node:sqlite + 真实 quota.js 评估器，覆盖
// 调周期/调额度后的身份、留痕、状态流转与通知去重。
// 用法： node test/quota.e2e.mjs
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { initEnergy } from '../server/energy.js'
import {
  initQuota, evaluateAll, createQuota, updateQuota, deleteQuota,
  handleAlert, listQuotas, listAlerts, periodRange
} from '../server/quota.js'

const DB_PATH = '/tmp/quota-test.db'
rmSync(DB_PATH, { force: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON;')

// 最小依赖数据：房间 + 一台高功率设备
db.exec(`CREATE TABLE rooms(id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE device_types(id INTEGER PRIMARY KEY, name TEXT, icon TEXT);
         CREATE TABLE devices(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type_id INTEGER, room_id INTEGER,
           status TEXT DEFAULT 'online', battery INTEGER DEFAULT 100, signal INTEGER DEFAULT 90,
           power_on INTEGER DEFAULT 0, watts INTEGER DEFAULT 10);`)
db.prepare('INSERT INTO rooms VALUES (1,?)').run('客厅')
db.prepare('INSERT INTO device_types VALUES (1,?,?)').run('空调', '❄️')
db.prepare('INSERT INTO devices (name,type_id,room_id,power_on,watts) VALUES (?,?,1,1,1500)').run('客厅空调')

const notifications = []
initEnergy(db)
initQuota(db, (entry) => { notifications.push(entry.action); if (process.env.VERBOSE) console.log('   [notify]', entry.action) })

// 用量恒定：清掉 energy 播种的 24h 演示数据与未结段，设备功率置 0（节拍也不会续开），
// 测试用量仅由随后注入的已结记录决定
db.prepare("UPDATE devices SET power_on=0, watts=0 WHERE id=1").run()
db.exec('DELETE FROM energy_segments; DELETE FROM energy_records;')

const iso = (d) => d.toISOString()
const now = new Date()
// 注入确定性已结用量：今日 10kWh，本周额外 2kWh（周一），本月额外 1kWh（1号）
function insertRecord(kwh, when) {
  insertRecordFor(1, '客厅', kwh, when)
}
function insertRecordFor(deviceId, room, kwh, when) {
  const name = deviceId === 1 ? '客厅空调' : '卧室空调'
  db.prepare(`INSERT INTO energy_records (device_id,device_name,room,watts,kwh,start_time,end_time,hour)
              VALUES (?,?,?,1500,?,?,?,?)`)
    .run(deviceId, name, room, kwh, iso(new Date(when.getTime() - 3600_000)), iso(when), when.getHours())
}
const dayStart = periodRange('daily', now).start
const weekStart = periodRange('weekly', now).start
const monthStart = periodRange('monthly', now).start
insertRecord(10, new Date(Math.max(dayStart.getTime() + 3600_000, now.getTime() - 1800_000)))
// 本周但非今日的 2kWh
const weekExtra = new Date(Math.min(weekStart.getTime() + 86400_000, dayStart.getTime() - 3600_000))
if (weekExtra.getTime() > weekStart.getTime()) insertRecord(2, weekExtra)
// 本月但非本周的 1kWh
const monthExtra = new Date(Math.min(monthStart.getTime() + 86400_000, weekStart.getTime() - 3600_000))
if (monthExtra.getTime() > monthStart.getTime()) insertRecord(1, monthExtra)
// 清掉 seedQuotas 按演示规则自动播种的额度与告警，测试完全自控
db.exec('DELETE FROM quota_alerts; DELETE FROM quota_adjustments; DELETE FROM energy_quotas;')
notifications.length = 0

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}
const alertsOf = (quotaId) => db.prepare('SELECT * FROM quota_alerts WHERE quota_id=? ORDER BY id').all(quotaId)
const activeOf = (quotaId, at = new Date()) => {
  const { start } = periodRange(listQuotas(at).find((q) => q.id === quotaId).period, at)
  return db.prepare('SELECT * FROM quota_alerts WHERE quota_id=? AND period=? AND period_start=? AND status IN (?,?)')
    .get(quotaId, listQuotas(at).find((q) => q.id === quotaId).period, start.toISOString(), 'open', 'handling')
}

console.log('\n[1] 新建 daily 额度 9kWh（用量10 → 直接超标）')
const qid = createQuota({ scope: 'device', device_id: 1, period: 'daily', limit_kwh: 9, reason: '测试' })
evaluateAll(new Date(now.getTime() + 1000))
let a = activeOf(qid)
check('立即生成 error 告警', !!a && a.level === 'error')
check('limit_kwh 快照=9', a?.limit_kwh === 9, `got ${a?.limit_kwh}`)
check('通知 1 次（新建）', notifications.length === 1, `got ${notifications.length}`)
const firstAlertId = a.id

console.log('\n[2] 上调额度到 20kWh（占比50%）→ 未闭环告警应自动解除（防误报）')
updateQuota(qid, { limit_kwh: 20 })
a = alertsOf(qid).find((x) => x.id === firstAlertId)
check('旧告警状态=ignored', a.status === 'ignored', `got ${a.status}`)
check('解除说明写入备注', a.note.includes('自动解除'))
check('看板无未闭环告警', !activeOf(qid))
const v = listQuotas().find((q) => q.id === qid)
check('listQuotas 不再挂告警', !v.alert)

console.log('\n[3] 再下调到 9.5kWh → 已闭环告警应重开（防漏报），且只通知一次')
const nBefore = notifications.length
updateQuota(qid, { limit_kwh: 9.5 })
a = alertsOf(qid).find((x) => x.id === firstAlertId)
check('复用同一告警 id 重开（历史连续）', a && a.status === 'open' && a.id === firstAlertId, `status=${a?.status}`)
check('level 重算为 error', a?.level === 'error')
check('limit_kwh 同步为 9.5', a?.limit_kwh === 9.5)
check('period 仍为 daily', a?.period === 'daily')
check('handled_at 被清空', a?.handled_at == null)
check('notified_at 已刷新（重开批次）', a?.notified_at && a.notified_at !== a.created_at)
check('备注保留重开说明', a?.note.includes('自动重开'))
check('重开通知恰好 1 次', notifications.length === nBefore + 1, `got ${notifications.length - nBefore}`)

console.log('\n[4] 额度调到 11.5（warn 区间 87%）→ error 应降级为 warn，不重复通知')
{
  const n0 = notifications.length
  updateQuota(qid, { limit_kwh: 11.5 })
  a = activeOf(qid)
  check('级别降级为 warn', a?.level === 'warn', `got ${a?.level}`)
  check('阈值快照=11.5', a?.limit_kwh === 11.5)
  check('降级不发通知', notifications.length === n0)
}

console.log('\n[5] 调回 9.5 → warn 升级 error，通知一次')
{
  const n0 = notifications.length
  updateQuota(qid, { limit_kwh: 9.5 })
  a = activeOf(qid)
  check('升级为 error', a?.level === 'error')
  check('升级通知 1 次', notifications.length === n0 + 1)
}

console.log('\n[6] 处理流转 open→handling→resolved，调额后只刷新读数不复活')
handleAlert(firstAlertId, { status: 'handling', note: '排查中' })
handleAlert(firstAlertId, { status: 'resolved', note: '已处理完' })
{
  const n0 = notifications.length
  updateQuota(qid, { limit_kwh: 9.2 }) // 仍是 error，但属于配置变更 → 重开
  a = alertsOf(qid).find((x) => x.id === firstAlertId)
  check('配置变更导致 resolved 重开 open', a.status === 'open', `got ${a.status}`)
  check('重开发通知', notifications.length === n0 + 1)
  handleAlert(firstAlertId, { status: 'resolved', note: '再次处理' })
}
{
  // 无配置变更的自然用量波动（直接改读数模拟）不得复活
  db.prepare('UPDATE quota_alerts SET notified_at=NULL WHERE id=?').run(firstAlertId)
  const n0 = notifications.length
  evaluateAll(new Date(now.getTime() + 60_000))
  a = alertsOf(qid).find((x) => x.id === firstAlertId)
  check('无配置变更时 resolved 不复活', a.status === 'resolved')
  check('不产生通知', notifications.length === n0)
}

console.log('\n[7] 切换周期 daily→weekly：旧告警结转留痕、新周期独立评估')
{
  // 当前 daily 9.5 处于 resolved，先确保存在一条未关闭的 daily 告警用于验证结转
  handleAlert(firstAlertId, { status: 'open', note: '' })
  const oldRows = alertsOf(qid).length
  updateQuota(qid, { period: 'weekly', limit_kwh: 100 }) // 周用量 ≤13，占比远低
  const rows = alertsOf(qid)
  check('旧 daily 告警记录仍在（历史留存）', rows.length === oldRows)
  const oldDaily = rows.filter((r) => r.period === 'daily')
  check('daily 旧告警全部关闭', oldDaily.every((r) => ['resolved', 'ignored'].includes(r.status)))
  const carried = oldDaily.filter((r) => r.status === 'ignored')
    .find((r) => r.note.includes('周期调整'))
  check('结转备注说明是周期调整而非自然结转', !!carried)
  check('weekly 未超限不产生新告警', !activeOf(qid))
  // 下调 weekly 额度到 10 → 周用量 12 超标，产生 weekly 身份告警
  updateQuota(qid, { period: 'weekly', limit_kwh: 10 })
  const wAlert = activeOf(qid)
  check('weekly 告警生成且 period=weekly', wAlert?.period === 'weekly' && wAlert?.level === 'error')
  check('与 daily 告警 id 不同', wAlert.id !== firstAlertId)
  const dup = db.prepare('SELECT COUNT(*) c FROM quota_alerts WHERE quota_id=? AND period=? AND period_start=?')
    .get(qid, 'weekly', wAlert.period_start).c
  check('身份键唯一', dup === 1)
}

console.log('\n[8] 同一周期起点、不同周期类型的告警可共存（周一 00:00 日/周起点重合）')
{
  // 旧身份键 UNIQUE(quota_id,period_start) 会在这种场景撞键丢告警；新身份键含 period
  const qid2 = 999001
  const { start, end } = periodRange('daily', now)
  const wEnd = new Date(start.getTime() + 7 * 86400_000)
  const ins = db.prepare(`INSERT INTO quota_alerts (quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,created_at,updated_at,notified_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  let threw = false
  try {
    ins.run(qid2, 'device', '客厅空调', 'daily', start.toISOString(), end.toISOString(), 'warn', 10, 9,
      'ignored', now.toISOString(), now.toISOString(), null)
    ins.run(qid2, 'device', '客厅空调', 'weekly', start.toISOString(), wEnd.toISOString(), 'error', 12, 10,
      'open', now.toISOString(), now.toISOString(), now.toISOString())
  } catch (e) { threw = true; console.log('   ', e.message) }
  check('同起点 daily/weekly 两条告警均落库', !threw)
  // 游离 quota_id（999001）会被删除额度清算逻辑解除，但不应因身份冲突报错
  try { evaluateAll(new Date(now.getTime() + 120_000)); } catch (e) { threw = true; console.log('   ', e.message) }
  check('评估不撞唯一键、不抛错', !threw)
  db.prepare('DELETE FROM quota_alerts WHERE quota_id=?').run(qid2)
}

console.log('\n[9] 停用额度 → 未关闭告警自动解除；重新启用仍超限时重开')
{
  updateQuota(qid, { period: 'weekly', enabled: false })
  const open = db.prepare("SELECT COUNT(*) c FROM quota_alerts WHERE quota_id=? AND status IN ('open','handling')").get(qid).c
  check('停用后无未关闭告警', open === 0, `got ${open}`)
  const n0 = notifications.length
  updateQuota(qid, { enabled: true })
  const a2 = activeOf(qid)
  check('重新启用超限后重开', a2?.status === 'open' && a2?.level === 'error', `got ${a2?.status}/${a2?.level}`)
  check('重开有通知', notifications.length === n0 + 1)
}

console.log('\n[10] 删除额度 → 残留告警解除、调整记录留痕')
{
  deleteQuota(qid, '测试删除')
  const open = db.prepare("SELECT COUNT(*) c FROM quota_alerts WHERE quota_id=? AND status IN ('open','handling')").get(qid).c
  check('删除后无未关闭告警', open === 0)
  const delAdj = db.prepare("SELECT * FROM quota_adjustments WHERE quota_id=? AND action='delete' ORDER BY id DESC LIMIT 1").get(qid)
  check('delete 留痕存在', !!delAdj && delAdj.reason === '测试删除')
  const allHistory = db.prepare('SELECT COUNT(*) c FROM quota_alerts WHERE quota_id=?').get(qid).c
  check('历史告警全部保留', allHistory >= 2, `got ${allHistory}`)
}

console.log('\n[11] 重复通知防护：连续评估不产生新通知、不改变 notified_at')
{
  db.prepare('INSERT INTO rooms VALUES (2,?)').run('卧室')
  db.prepare('INSERT INTO devices (name,type_id,room_id,power_on,watts) VALUES (?,?,2,0,10)').run('卧室空调')
  insertRecordFor(2, '卧室', 13, new Date(now.getTime() - 600_000))
  const n0 = notifications.length
  let id2
  try { id2 = createQuota({ scope: 'device', device_id: 2, period: 'daily', limit_kwh: 5 }) } catch (e) { console.log('   [probe11]', e.message) }
  if (!id2) { check('多次评估只通知一次', false, 'createQuota 失败'); check('notified_at 不被重复刷新', false); } else {
  const created = notifications.length - n0
  const before = db.prepare('SELECT notified_at FROM quota_alerts WHERE quota_id=?').get(id2).notified_at
  evaluateAll(new Date(now.getTime() + 180_000))
  evaluateAll(new Date(now.getTime() + 240_000))
  const after = db.prepare('SELECT notified_at FROM quota_alerts WHERE quota_id=?').get(id2).notified_at
  check('新建通知恰好 1 次', created === 1, `got ${created}`)
  check('连续评估不产生额外通知', notifications.length === n0 + 1, `got ${notifications.length - n0}`)
  check('notified_at 不被重复刷新', before === after)
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
rmSync(DB_PATH, { force: true })
process.exit(fail ? 1 : 0)
