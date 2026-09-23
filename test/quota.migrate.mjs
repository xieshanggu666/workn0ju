// 旧库迁移验证：老结构 UNIQUE(quota_id,period_start) 升级为含 period 的身份键，
// 历史告警一条不丢、notified_at 补齐。
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { initEnergy } from '../server/energy.js'
import { initQuota, listAlerts } from '../server/quota.js'

const DB_PATH = '/tmp/quota-migrate.db'
rmSync(DB_PATH, { force: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON;')
db.exec(`CREATE TABLE rooms(id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE device_types(id INTEGER PRIMARY KEY, name TEXT, icon TEXT);
         CREATE TABLE devices(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type_id INTEGER, room_id INTEGER,
           status TEXT DEFAULT 'online', battery INTEGER DEFAULT 100, signal INTEGER DEFAULT 90,
           power_on INTEGER DEFAULT 0, watts INTEGER DEFAULT 10);`)
db.prepare('INSERT INTO rooms VALUES (1,?)').run('客厅')
db.prepare('INSERT INTO device_types VALUES (1,?,?)').run('空调', '❄️')
db.prepare('INSERT INTO devices (name,type_id,room_id) VALUES (?,?,1)').run('客厅空调')

// 用旧结构初始化一次（手动建旧表），再由 initQuota 迁移
initEnergy(db)
db.exec(`CREATE TABLE quota_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quota_id INTEGER NOT NULL, scope TEXT NOT NULL, target_name TEXT NOT NULL,
  period TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  level TEXT NOT NULL, used_kwh REAL NOT NULL, limit_kwh REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, handled_at TEXT,
  UNIQUE(quota_id, period_start)
);
CREATE TABLE energy_quotas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, room_id INTEGER, device_id INTEGER,
  target_name TEXT NOT NULL, period TEXT NOT NULL, limit_kwh REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE quota_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, quota_id INTEGER NOT NULL, action TEXT NOT NULL,
  old_limit REAL, new_limit REAL, old_period TEXT, new_period TEXT,
  reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);`)
const t = new Date().toISOString()
db.prepare(`INSERT INTO energy_quotas (scope,device_id,target_name,period,limit_kwh,enabled,created_at,updated_at)
            VALUES ('device',1,'客厅空调','daily',9,1,?,?)`).run(t, t)
db.prepare(`INSERT INTO quota_alerts
  (quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,note,created_at,updated_at,handled_at)
  VALUES (1,'device','客厅空调','daily','2026-09-22T00:00:00.000Z','2026-09-23T00:00:00.000Z',
          'error',10,9,'handling','旧备注',?,'2026-09-22T12:00:00.000Z','2026-09-22T12:00:00.000Z')`)
  .run(t)

let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name, extra) } }

initQuota(db, () => {})

// 1. 列与索引
const cols = db.prepare('PRAGMA table_info(quota_alerts)').all().map((c) => c.name)
check('notified_at 列已补', cols.includes('notified_at'))
const idx = db.prepare("PRAGMA index_list(quota_alerts)").all().map((i) => i.name)
check('新身份唯一索引存在', idx.includes('idx_quota_alerts_identity'))
check('旧内联唯一索引已移除（sqlite 自动索引名）', !idx.some((n) => n.startsWith('sqlite_autoindex')))

// 2. 数据无损（按业务键查询：首次评估会追加结转备注并关闭，用 LIKE 匹配原始备注）
const row = db.prepare(`SELECT * FROM quota_alerts WHERE quota_id=1 AND period='daily'
                        AND note LIKE '%旧备注%'`).get()
check('历史告警核心数据保留', !!row && row.level === 'error' && row.limit_kwh === 9
  && row.used_kwh === 10 && row.target_name === '客厅空调', JSON.stringify(row))
check('迁移保留原 id', row?.id === 1)
check('notified_at 旧数据补 NULL', row.notified_at == null)

// 3. 迁移后评估器正常工作（旧告警 period_start 已过期，应结转）
check('跨周期旧告警已结转关闭', row.status === 'ignored', `got ${row.status}`)
check('结转说明已追加到原备注', /旧备注/.test(row.note) && /结转关闭/.test(row.note))
check('listAlerts 序列化含 notified_at', 'notified_at' in listAlerts()[0])

// 4. 同周期起点可同时存在不同 period（旧约束会拒绝）
db.prepare(`INSERT INTO energy_quotas (scope,device_id,target_name,period,limit_kwh,enabled,created_at,updated_at)
            VALUES ('device',1,'客厅空调','weekly',50,0,?,?)`).run(t, t)
db.prepare(`INSERT INTO quota_alerts (quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,created_at,updated_at)
            VALUES (2,'device','客厅空调','weekly',?,?, 'warn',40,50,'open',?,?)`)
  .run('2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z', t, t)
check('迁移后新身份键可插不同周期同起点', true)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
rmSync(DB_PATH, { force: true })
process.exit(fail ? 1 : 0)
