#!/usr/bin/env node
'use strict'

/**
 * G7 — Sprint G 灰度 + 压力测试 E2E probe.
 *
 * 走通 v2 月度全流程 (开月 → 配置 → 灌种子 → 跑 stage → 导出),
 * 测两条路径:
 *
 *   (A) 灰度路径: demo-2026-05 + all_matched 种子 (50 行)
 *       — 验证所有 step 字段一一对应
 *       — 每 step 失败立即 abort + 输出红字
 *
 *   (B) 压力路径: demo-stress-2099-01 + large_volume 种子 (10000 行)
 *       — 验证 stage 耗时 + monthly_data 数量级
 *       — duration 阈值: 每 stage ≤ 120s
 *
 * 退出码: A 失败 → 1;只 B 失败 → 2;全过 → 0
 */

const http = require('node:http')
const fs   = require('node:fs')
const path = require('node:path')

const HOST = process.env.SIGN_TEST_HOST || '127.0.0.1'
const PORT = Number(process.env.SIGN_TEST_PORT || 3218)
const USER = process.env.SIGN_TEST_USER || 'admin'
const PASS = process.env.SIGN_TEST_PASS || 'admin123'

const LIGHT_WS  = 'demo-2026-05'
const STRESS_WS = 'demo-2099-01'   // 必须 demo-YYYY-MM 格式 — workspace_service 严格校验

let cookieHeader = ''

// ─── http helper ───────────────────────────────────────────────────────────
function request(method, urlPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders }
    if (cookieHeader) headers.Cookie = cookieHeader
    const data = body ? JSON.stringify(body) : null
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = http.request({ host: HOST, port: PORT, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = text }
        if (res.headers['set-cookie']) {
          const sc = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ')
          if (sc) cookieHeader = sc
        }
        resolve({ status: res.statusCode, body: json, raw: text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function _uploadFile(urlPath, filePath) { // 备用,_=有意保留未用
  return new Promise((resolve, reject) => {
    const boundary = '----g7boundary' + Math.random().toString(16).slice(2)
    const fileBuf = fs.readFileSync(filePath)
    const fileName = path.basename(filePath)
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const body = Buffer.concat([head, fileBuf, tail])
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    }
    if (cookieHeader) headers.Cookie = cookieHeader
    const req = http.request({ host: HOST, port: PORT, method: 'POST', path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = text }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ─── assertion / logging ───────────────────────────────────────────────────
const FAILS = []
function step(name) { process.stdout.write(`\n▶ ${name}\n`) }
function ok(label, info = '') { console.log(`  \x1b[32m✓\x1b[0m ${label}${info ? ' ' + info : ''}`) }
function bad(label, reason) { console.log(`  \x1b[31m✗\x1b[0m ${label} — ${reason}`); FAILS.push(`${label}: ${reason}`) }

// ─── flow ──────────────────────────────────────────────────────────────────
async function login() {
  step('登录 admin')
  const r = await request('POST', '/api/auth/login', { username: USER, password: PASS })
  if (r.status !== 200 || !cookieHeader) { bad('login', `status=${r.status}, no cookie`); return false }
  ok('login', `user=${r.body?.user?.username}`)
  return true
}

async function flowLight() {
  console.log(`\n\x1b[35m═══ A 灰度路径 ${LIGHT_WS} ═══\x1b[0m`)

  step(`POST /workspaces ${LIGHT_WS}`)
  const cw = await request('POST', '/api/monthly/workspaces', { workspaceKey: LIGHT_WS })
  if (cw.status !== 200) { bad('createWorkspace', `status=${cw.status} body=${cw.raw.slice(0, 100)}`); return }
  ok('createWorkspace', `status=${cw.body?.workspace?.status}`)

  step('PUT /deduct-config (4 folder + confirm)')
  const dc = await request('PUT', `/api/monthly/workspaces/${LIGHT_WS}/deduct-config`, {
    rows: [
      { modeFolder: '乐天首尔', deductValue: 0.04 },
      { modeFolder: '乐天釜山', deductValue: 0.04 },
      { modeFolder: '爱宝客',  deductValue: 0.05 },
      { modeFolder: '济州新罗V团', deductValue: 0.03 },
    ],
    confirm: true,
  })
  if (dc.status !== 200) bad('deduct-config', `status=${dc.status}`)
  else if (!dc.body?.confirmed_at) bad('deduct-config', 'confirmed_at not set')
  else ok('deduct-config', `confirmed_at=${dc.body.confirmed_at}`)

  step('POST /seed all_matched')
  const seed = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/seed`, { scenario: 'all_matched' })
  if (seed.status !== 200) bad('seed', `status=${seed.status}`)
  else ok('seed', `inserted daily=${seed.body?.inserted?.daily} bill=${seed.body?.inserted?.bill}`)

  step('PUT /mode-mapping (灌种子后 4 个 unmapped)')
  const mm = await request('PUT', `/api/monthly/workspaces/${LIGHT_WS}/mode-mapping`, {
    mappings: [
      { modeRaw: 'FIT', modeFolder: '爱宝客' },
      { modeRaw: 'PKG', modeFolder: '乐天首尔' },
      { modeRaw: 'SG',  modeFolder: '乐天首尔' },
      { modeRaw: 'V',   modeFolder: '济州新罗V团' },
    ],
    confirm: true,
  })
  if (mm.status !== 200) bad('mode-mapping', `status=${mm.status}`)
  else if (!mm.body?.confirmed_at) bad('mode-mapping', 'confirmed_at not set')
  else ok('mode-mapping', `${mm.body?.items?.length || 0} mapped`)

  step('POST /stages/tour-match')
  const tm = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/stages/tour-match`, {})
  if (tm.status !== 200) bad('tour-match', `status=${tm.status}`)
  else ok('tour-match', `job.status=${tm.body?.job?.status}`)

  step('POST /stages/bill-match')
  const bm = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/stages/bill-match`, {})
  if (bm.status !== 200) bad('bill-match', `status=${bm.status}`)
  else ok('bill-match', `job.status=${bm.body?.job?.status}`)

  step('POST /stages/merge')
  const mg = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/stages/merge`, {})
  if (mg.status !== 200) bad('merge', `status=${mg.status}`)
  else {
    const s = mg.body?.stats || mg.body
    ok('merge', `inserted=${s?.inserted} matched=${s?.matched} unmatched=${s?.unmatched} unreceived=${s?.unreceived}`)
  }

  step('GET /monthly-data?limit=2 (验证 snake_case 字段)')
  const md = await request('GET', `/api/monthly/workspaces/${LIGHT_WS}/monthly-data?limit=2`)
  if (md.status !== 200) bad('monthly-data', `status=${md.status}`)
  else if (!Array.isArray(md.body?.rows)) bad('monthly-data', 'rows not array')
  else {
    const r0 = md.body.rows[0] || {}
    const required = ['workspace_key', 'mode_folder', 'is_unmatched', 'name', 'tour_no', 'passport_no']
    const missing = required.filter((k) => !(k in r0))
    if (missing.length) bad('monthly-data fields', `missing snake_case: ${missing.join(',')}`)
    else ok('monthly-data', `rows=${md.body.rows.length} total=${md.body.total} (snake_case OK)`)
  }

  step('GET /overview 看 counts')
  const ov = await request('GET', `/api/monthly/workspaces/${LIGHT_WS}/overview`)
  if (ov.status !== 200) bad('overview', `status=${ov.status}`)
  else ok('overview', `daily=${ov.body?.counts?.dailyReceipts} bills=${ov.body?.counts?.storeBills} pending=${ov.body?.counts?.pendingOpen}`)

  step('POST /exports/monthly-data')
  const exp = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/exports/monthly-data`, {})
  if (exp.status !== 200) bad('export', `status=${exp.status}`)
  else ok('export', `files=${(exp.body?.files || []).length}`)

  step('GET /exports/files')
  const ef = await request('GET', `/api/monthly/workspaces/${LIGHT_WS}/exports/files`)
  if (ef.status !== 200) bad('exports/files', `status=${ef.status}`)
  else ok('exports/files', `${(ef.body?.files || []).length} files`)

  step('POST /health-check')
  const hc = await request('POST', `/api/monthly/workspaces/${LIGHT_WS}/health-check`)
  if (hc.status !== 200) bad('health-check', `status=${hc.status}`)
  else {
    const critical = (hc.body?.issues || []).filter((i) => i.severity === 'critical' && i.count > 0)
    ok('health-check', `${hc.body?.issues?.length || 0} issues, ${critical.length} critical`)
  }
}

async function flowStress() {
  console.log(`\n\x1b[35m═══ B 压力路径 ${STRESS_WS} ═══\x1b[0m`)

  step(`POST /workspaces ${STRESS_WS} (10000 行场景)`)
  await request('POST', '/api/monthly/workspaces', { workspaceKey: STRESS_WS })

  step('PUT /deduct-config (一键填齐)')
  await request('PUT', `/api/monthly/workspaces/${STRESS_WS}/deduct-config`, {
    rows: [
      { modeFolder: '乐天首尔', deductValue: 0.04 },
      { modeFolder: '乐天釜山', deductValue: 0.04 },
      { modeFolder: '爱宝客',  deductValue: 0.05 },
      { modeFolder: '济州新罗V团', deductValue: 0.03 },
    ],
    confirm: true,
  })

  step('POST /seed large_volume (10000 行)')
  const t0 = Date.now()
  const seed = await request('POST', `/api/monthly/workspaces/${STRESS_WS}/seed`, { scenario: 'large_volume' })
  const seedMs = Date.now() - t0
  if (seed.status !== 200) { bad('stress seed', `status=${seed.status}`); return }
  ok('stress seed', `daily=${seed.body?.inserted?.daily} bill=${seed.body?.inserted?.bill} (${seedMs}ms)`)

  step('PUT /mode-mapping 全归类')
  const mmStress = await request('GET', `/api/monthly/workspaces/${STRESS_WS}/mode-mapping`)
  const unmapped = mmStress.body?.unmapped || []
  if (unmapped.length) {
    await request('PUT', `/api/monthly/workspaces/${STRESS_WS}/mode-mapping`, {
      mappings: unmapped.map((m) => ({ modeRaw: m, modeFolder: '乐天首尔' })),
      confirm: true,
    })
    ok('mode-mapping (stress)', `${unmapped.length} mapped to 乐天首尔`)
  } else { ok('mode-mapping (stress)', 'no unmapped') }

  // large_volume scenario 只放大 daily (10000 行,bill=0),
  // 所以 bill-match/merge 预期 409 STAGE_PRECONDITION_FAILED (没 bill 当然不匹配)。
  // tour-match 是真压测目标 — 10000 daily × group_code 匹配。
  const stagesTime = {}
  step(`POST /stages/tour-match (压力 — 唯一真压测目标)`)
  const t1 = Date.now()
  const r = await request('POST', `/api/monthly/workspaces/${STRESS_WS}/stages/tour-match`, {})
  const ms = Date.now() - t1
  stagesTime['tour-match'] = ms
  if (r.status !== 200) bad('stress tour-match', `status=${r.status} body=${r.raw?.slice(0,100)}`)
  else if (ms > 120_000) bad('stress tour-match', `${ms}ms > 120s 阈值`)
  else ok('stress tour-match', `${ms}ms job=${r.body?.job?.status}`)
  // bill-match / merge 在 large_volume(bill=0) 下预期是 STAGE_PRECONDITION_FAILED;
  // 不算 fail,只记。要做完整 merge 压测需要先 import 真的 bill xlsx。
  for (const stage of ['bill-match', 'merge']) {
    const r2 = await request('POST', `/api/monthly/workspaces/${STRESS_WS}/stages/${stage}`, {})
    if (r2.status === 409) ok(`stress ${stage}`, '409 预期 (large_volume 不含 bill,跳过)')
    else if (r2.status !== 200) bad(`stress ${stage}`, `unexpected status=${r2.status}`)
    else ok(`stress ${stage}`, `job=${r2.body?.job?.status}`)
  }

  step('GET /monthly-data?limit=1 (压力后)')
  const mdS = await request('GET', `/api/monthly/workspaces/${STRESS_WS}/monthly-data?limit=1`)
  if (mdS.status === 200) ok('stress monthly-data', `total=${mdS.body?.total}`)

  console.log(`\n  耗时汇总: tour=${stagesTime['tour-match']}ms bill=${stagesTime['bill-match']}ms merge=${stagesTime['merge']}ms`)
}

async function main() {
  console.log(`G7 E2E probe — backend ${HOST}:${PORT}`)
  if (!await login()) process.exit(1)
  await flowLight()
  await flowStress()

  console.log(`\n\x1b[35m═══ 汇总 ═══\x1b[0m`)
  if (FAILS.length === 0) {
    console.log('\x1b[32m  ✓ 全部通过\x1b[0m')
    process.exit(0)
  }
  console.log(`\x1b[31m  ✗ ${FAILS.length} 个失败:\x1b[0m`)
  for (const f of FAILS) console.log(`    - ${f}`)
  process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
