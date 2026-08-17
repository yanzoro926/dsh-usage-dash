/**
 * dsh-usage-dash host half.
 *
 * Serves one fenced JSON endpoint, /usage-dash/api/summary, that reads the
 * local OpenCode history database (read-only) and projects the OpenCode Go
 * plan spend into its three quota windows:
 *
 *   - 5h rolling   (limit $12)
 *   - weekly       (limit $30, UTC Monday 00:00 boundary)
 *   - monthly      (limit $60, UTC calendar-month boundary)
 *
 * Limits are the published OpenCode Go plan limits (see
 * https://github.com/openusage-community/openusage/blob/main/docs/providers/opencode-go.md).
 *
 * The route passes the same browser-trust fence pattern as the DSH /api
 * gateway: only loopback Host headers (and same-origin browser markers) may
 * reach it. This is a DNS-rebinding / cross-site defense, not authentication —
 * the data is the local user's own spend.
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-usage-dash'

/** Services required before mounting. */
export const inject = ['webServer']

/** OpenCode Go published plan limits (USD). */
export const GO_LIMITS = Object.freeze({ rolling5h: 12, weekly: 30, monthly: 60 })

const ROLLING_MS = 5 * 60 * 60 * 1000

export function opencodeDbPath() {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

// ── UTC window helpers ────────────────────────────────────────────────────

function utcMondayStart(now) {
  const d = new Date(now)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
}

function utcMonthStart(now) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function utcNextMonthStart(now) {
  const d = new Date(now)
  return d.getUTCMonth() === 11
    ? Date.UTC(d.getUTCFullYear() + 1, 0, 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

// ── Data access ───────────────────────────────────────────────────────────

/**
 * Raw spend rows for opencode-go sessions: `{ t, cost }` with t in ms.
 * A missing or malformed database yields an empty list (the provider stays
 * visible with zero spend and a note) — never a hard failure.
 */
export function readSpendRows(dbPath = opencodeDbPath()) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return { rows: [], note: 'no-data' }
  }
  try {
    const rows = db
      .prepare(
        `SELECT time_updated AS t, cost AS c FROM session
         WHERE json_valid(model)
           AND json_extract(model, '$.providerID') = 'opencode-go'
           AND cost > 0`
      )
      .all()
    return {
      rows: rows.map((r) => ({ t: Number(r.t), c: Number(r.c) })),
      note: undefined,
    }
  } catch {
    return { rows: [], note: 'no-data' }
  } finally {
    try { db.close() } catch { /* already closed */ }
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function windowOf(rows, sinceMs, limitUsd, key, label, resetAtMs, note) {
  const inWindow = rows.filter((r) => r.t >= sinceMs)
  const spent = round2(inWindow.reduce((sum, r) => sum + r.c, 0))
  const pct = Math.min(100, round2((spent / limitUsd) * 100))
  let reset = resetAtMs
  if (key === 'rolling5h') {
    // Rolling window: nothing "resets"; report when the oldest included row
    // drops out of the window instead.
    reset = inWindow.length > 0 ? Math.min(...inWindow.map((r) => r.t)) + ROLLING_MS : null
  }
  return {
    key,
    label,
    spentUsd: spent,
    limitUsd,
    pct,
    remainingUsd: round2(Math.max(0, limitUsd - spent)),
    resetAtMs: reset,
    note,
  }
}

/** Pure projection used by the route (and by the test script). */
export function computeSummary(rows, now = Date.now()) {
  const allTime = round2(rows.reduce((sum, r) => sum + r.c, 0))
  const windows = [
    windowOf(rows, now - ROLLING_MS, GO_LIMITS.rolling5h, 'rolling5h', '5h 滚动', null, '最近 5 小时'),
    windowOf(rows, utcMondayStart(now), GO_LIMITS.weekly, 'weekly', '本周', utcMondayStart(now) + 7 * 24 * 60 * 60 * 1000, 'UTC 周一起算'),
    windowOf(rows, utcMonthStart(now), GO_LIMITS.monthly, 'monthly', '本月', utcNextMonthStart(now), 'UTC 自然月'),
  ]
  return { allTimeUsd: allTime, windows }
}

// ── OpenCode Go official quota API ────────────────────────────────────────
//
// GET https://opencode.ai/zen/go/v1/usage with `Authorization: Bearer <key>`
// returns the plan's own accounting: rolling (5h) / weekly / monthly windows
// with percent + resetsAt. Token resolution order:
//   1. user-provided token file (~/.dsh/storages/dsh-usage-dash.json)
//   2. the opencode-go key already stored in ~/.local/share/opencode/auth.json
// When the API is unavailable, the summary falls back to the local SQLite
// projection and carries `apiError` so the UI can say so.

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export function goTokenFilePath() {
  return join(homedir(), '.dsh', 'storages', 'dsh-usage-dash.json')
}

function readTokenFile() {
  try {
    const raw = JSON.parse(readFileSync(goTokenFilePath(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeTokenFile(obj) {
  mkdirSync(join(homedir(), '.dsh', 'storages'), { recursive: true })
  writeFileSync(goTokenFilePath(), JSON.stringify(obj, null, 2), { mode: 0o600 })
}

export function readGoToken() {
  const raw = readTokenFile()
  if (typeof raw.token === 'string' && raw.token.trim()) {
    return { token: raw.token.trim(), source: 'custom' }
  }
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8')
    )
    const go = auth && auth['opencode-go']
    if (go && typeof go.key === 'string' && go.key.trim()) {
      return { token: go.key.trim(), source: 'auth.json' }
    }
  } catch { /* no auth.json */ }
  return { token: null, source: null }
}

export function saveGoToken(token) {
  const obj = readTokenFile()
  obj.token = token
  writeTokenFile(obj)
}

export function clearGoToken() {
  const obj = readTokenFile()
  delete obj.token
  writeTokenFile(obj)
}

// DeepSeek 官方 API key（可选，用于余额查询）——同文件独立字段。
export function readDeepSeekKey() {
  const raw = readTokenFile()
  return typeof raw.deepseekToken === 'string' && raw.deepseekToken.trim()
    ? raw.deepseekToken.trim()
    : null
}

export function saveDeepSeekKey(key) {
  const obj = readTokenFile()
  obj.deepseekToken = key
  writeTokenFile(obj)
}

export function clearDeepSeekKey() {
  const obj = readTokenFile()
  delete obj.deepseekToken
  writeTokenFile(obj)
}

// ── DeepSeek official balance ─────────────────────────────────────────────
//
// GET https://api.deepseek.com/user/balance with Bearer API key returns the
// account balance (same data as platform.deepseek.com/usage):
//   { is_available, balance_infos: [ { currency, total_balance,
//       granted_balance, topped_up_balance } ] }

const DS_BALANCE_URL = 'https://api.deepseek.com/user/balance'

const dsBalanceCache = { key: null, at: 0, result: null }

export async function fetchDeepSeekBalance(key, force = false) {
  const now = Date.now()
  if (!force && dsBalanceCache.key === key && dsBalanceCache.result && now - dsBalanceCache.at < 60_000) {
    return dsBalanceCache.result
  }
  let result
  try {
    const res = await fetch(DS_BALANCE_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status !== 200) {
      result = { ok: false, error: 'HTTP ' + res.status }
    } else {
      const body = await res.json()
      const infos = (body && body.balance_infos) || []
      const info = infos[0] || null
      if (!info) {
        result = { ok: false, error: '响应缺少 balance_infos' }
      } else {
        result = {
          ok: true,
          updatedAtMs: now,
          isAvailable: body.is_available !== false,
          currency: typeof info.currency === 'string' ? info.currency : 'CNY',
          total: String(info.total_balance ?? '0'),
          granted: String(info.granted_balance ?? '0'),
          toppedUp: String(info.topped_up_balance ?? '0'),
        }
      }
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) }
  }
  dsBalanceCache.key = key
  dsBalanceCache.at = now
  dsBalanceCache.result = result
  return result
}

export function invalidateDeepSeekCache() {
  dsBalanceCache.key = null
  dsBalanceCache.at = 0
  dsBalanceCache.result = null
}

function hintOf(token) {
  if (typeof token !== 'string' || token.length < 12) return token || ''
  return token.slice(0, 8) + '…' + token.slice(-4)
}

const GO_WINDOW_SLOTS = [
  ['rolling', 'rolling5h', '5h'],
  ['weekly', 'weekly', 'wk'],
  ['monthly', 'monthly', '30d'],
]

export function goWindowsOf(usage) {
  const windows = []
  for (const [slot, key, label] of GO_WINDOW_SLOTS) {
    const w = usage && usage[slot]
    if (!w || typeof w.percent !== 'number') continue
    const pct = Number(w.percent)
    if (!Number.isFinite(pct)) continue
    windows.push({
      key,
      label,
      pct: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)),
      resetAtMs: typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) || null : null,
      note: '官方 API',
    })
  }
  return windows
}

const goApiCache = { token: null, at: 0, result: null }

export async function fetchGoUsage(token, force = false) {
  const now = Date.now()
  if (!force && goApiCache.token === token && goApiCache.result && now - goApiCache.at < 60_000) {
    return goApiCache.result
  }
  let result
  try {
    const res = await fetch(GO_USAGE_URL, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status !== 200) {
      result = { ok: false, httpStatus: res.status, error: 'HTTP ' + res.status }
    } else {
      const body = await res.json()
      const u = body && body.usage
      if (!u) {
        result = { ok: false, httpStatus: 200, error: '响应缺少 usage 字段' }
      } else {
        result = { ok: true, httpStatus: 200, updatedAtMs: now, windows: goWindowsOf(u) }
      }
    }
  } catch (e) {
    result = { ok: false, httpStatus: null, error: String((e && e.message) || e) }
  }
  goApiCache.token = token
  goApiCache.at = now
  goApiCache.result = result
  return result
}

function invalidateGoApiCache() {
  goApiCache.token = null
  goApiCache.at = 0
  goApiCache.result = null
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ── Volcengine Coding Plan (via official ark-cli) ─────────────────────────
//
// The Volcano Engine Coding Plan quota lives behind the official OpenAPI
// action GetCodingPlanUsage (AK/SK or SSO signed). The official CLI
// (`npm i @volcengine/ark-cli -g`) wraps it: `arkcli usage plan` returns
// `{ viewer, items }` where each subscribed item carries periods
// (CodingPlan: session / weekly / monthly with percent + reset_at).
// Shelling out keeps the signing logic out of this plugin and matches the
// official口径.

export function runArkcli(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const child = spawn('arkcli', args, {
      env: {
        ...process.env,
        ARKCLI_CALLER_TYPE: 'ai_agent',
        ARKCLI_CALLER_NAME: 'dsh',
        ARKCLI_SKILL_NAME: 'dsh-usage-dash',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: e && e.code === 'ENOENT' ? 'no-cli' : String((e && e.message) || e) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      if (!text && !err.trim()) {
        finish({ ok: false, error: 'empty output' })
        return
      }
      try {
        finish({ ok: true, data: JSON.parse(text) })
      } catch {
        finish({ ok: false, error: err.trim() || ('无法解析 arkcli 输出: ' + text.slice(0, 200)) })
      }
    })
  })
}

export function volcWindowsOf(item) {
  const windows = []
  for (const p of item.periods || []) {
    const label = String(p.label || '')
    let key = label
    if (label === '5h') key = 'rolling5h'
    else if (label === 'weekly') key = 'weekly'
    else if (label === 'monthly') key = 'monthly'
    else if (label === 'session') key = 'session'
    const pct = Number(p.percent)
    if (!Number.isFinite(pct)) continue
    windows.push({
      key,
      label: { rolling5h: '5h', weekly: 'wk', monthly: '30d', session: 'session' }[key] || label,
      pct: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)),
      resetAtMs: typeof p.reset_at === 'string' ? Date.parse(p.reset_at) || null : null,
      note: '火山官方 OpenAPI',
    })
  }
  return windows
}

const volcCache = { at: 0, result: null, inflight: null }

export function readVolcPlan(force = false, runner = runArkcli) {
  const now = Date.now()
  if (!force && volcCache.result && now - volcCache.at < 60_000) {
    return Promise.resolve(volcCache.result)
  }
  if (!force && volcCache.inflight) return volcCache.inflight
  const inflight = (async () => {
    let res = await runner(['usage', 'plan', '--json'])
    if (!res.ok && res.error !== 'no-cli' && res.error !== 'timeout') {
      // Some builds may not know --json: retry the plain form.
      res = await runner(['usage', 'plan'])
    }
    volcCache.result = res
    volcCache.at = Date.now()
    volcCache.inflight = null
    return res
  })()
  volcCache.inflight = inflight
  return inflight
}

// ── Custom plans (user-defined quota endpoints) ───────────────────────────
//
// Self-service extension point: users define additional plan providers as
// { id, name, url, token?, tokenHeader?, tokenPrefix? } entries stored in
// ~/.dsh/storages/dsh-usage-dash-custom.json. Each plan's URL must return
// one of two JSON shapes (auto-detected):
//   A. opencode style: { usage: { rolling|weekly|monthly: { percent, resetsAt } } }
//   B. flat list:      { windows: [ { label|key, percent, resetAt|resetsAt }, ... ] }

export function customPlansPath() {
  return join(homedir(), '.dsh', 'storages', 'dsh-usage-dash-custom.json')
}

export function readCustomPlans() {
  try {
    const raw = JSON.parse(readFileSync(customPlansPath(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.url === 'string')
  } catch {
    return []
  }
}

export function writeCustomPlans(plans) {
  mkdirSync(join(homedir(), '.dsh', 'storages'), { recursive: true })
  writeFileSync(customPlansPath(), JSON.stringify(plans, null, 2), { mode: 0o600 })
}

export function sanitizeCustomPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    url: plan.url,
    tokenSet: Boolean(plan.token && plan.token.trim()),
    tokenHint: plan.token ? hintOf(plan.token) : null,
  }
}

function keyOfLabel(label) {
  const l = String(label || '').toLowerCase()
  if (l === '5h' || l === 'rolling' || l === 'rolling5h') return 'rolling5h'
  if (l === 'weekly' || l === 'week' || l === 'wk' || l === '周') return 'weekly'
  if (l === 'monthly' || l === 'month' || l === '30d' || l === '月') return 'monthly'
  if (l === 'session' || l === 'ses') return 'session'
  return 'window:' + l
}

function labelOfKey(key) {
  return { rolling5h: '5h', weekly: 'wk', monthly: '30d', session: 'session' }[key] || null
}

/** Parse either accepted response shape into the unified window list. */
export function customWindowsOf(body) {
  // A. opencode style
  if (body && body.usage && typeof body.usage === 'object') {
    return goWindowsOf(body.usage).map((w) => ({ ...w, note: '自定义套餐' }))
  }
  // B. flat list
  if (body && Array.isArray(body.windows)) {
    const windows = []
    for (const w of body.windows) {
      if (!w || typeof w !== 'object') continue
      const pct = Number(w.percent ?? w.usedPercent)
      if (!Number.isFinite(pct)) continue
      const rawLabel = w.label ?? w.key ?? ''
      const key = keyOfLabel(rawLabel)
      const resetRaw = w.resetAt ?? w.resetsAt ?? w.reset_at
      const resetAtMs = typeof resetRaw === 'string' || typeof resetRaw === 'number'
        ? Date.parse(resetRaw) || null
        : null
      windows.push({
        key,
        label: labelOfKey(key) || String(rawLabel),
        pct: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)),
        resetAtMs,
        note: '自定义套餐',
      })
    }
    return windows
  }
  return []
}

const customCache = new Map()

export async function fetchCustomPlan(plan, force = false) {
  const cached = customCache.get(plan.id)
  const now = Date.now()
  if (!force && cached && cached.result && now - cached.at < 60_000) return cached.result
  let result
  try {
    const headers = { accept: 'application/json' }
    if (plan.token && plan.token.trim()) {
      const headerName = plan.tokenHeader || 'Authorization'
      const prefix = plan.tokenPrefix === undefined || plan.tokenPrefix === null ? 'Bearer' : plan.tokenPrefix
      headers[headerName] = prefix ? prefix + ' ' + plan.token.trim() : plan.token.trim()
    }
    const res = await fetch(plan.url, { headers, signal: AbortSignal.timeout(8_000) })
    if (res.status !== 200) {
      result = { ok: false, error: 'HTTP ' + res.status }
    } else {
      const body = await res.json()
      const windows = customWindowsOf(body)
      result = windows.length > 0
        ? { ok: true, windows, updatedAtMs: now }
        : { ok: false, error: '响应格式无法识别（需 usage.rolling/weekly/monthly 或 windows 数组）' }
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) }
  }
  customCache.set(plan.id, { at: now, result })
  return result
}

export function invalidateCustomCache() {
  customCache.clear()
}

// ── Browser trust fence ───────────────────────────────────────────────────

function header(req, name) {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isTrustedRequest(req) {
  const host = header(req, 'host')
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── Wire helpers ──────────────────────────────────────────────────────────

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

// ── Plugin body ───────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/usage-dash/api',
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname

          if (pathname === '/usage-dash/api/summary' && req.method === 'GET') {
            const providers = []
            // OpenCode Go: official API first, local SQLite projection as fallback.
            const tokenInfo = readGoToken()
            const sqlite = (() => {
              const { rows, note } = readSpendRows()
              const { allTimeUsd, windows } = computeSummary(rows)
              return { note: note ?? null, allTimeUsd, windows }
            })()
            const api = tokenInfo.token ? await fetchGoUsage(tokenInfo.token) : null
            if (api && api.ok && api.windows.length > 0) {
              providers.push({
                id: 'opencode-go',
                name: 'OpenCode Go',
                source: 'opencode.ai API',
                tokenSource: tokenInfo.source,
                updatedAtMs: api.updatedAtMs,
                windows: api.windows,
              })
            } else {
              providers.push({
                id: 'opencode-go',
                name: 'OpenCode Go',
                source: 'local sqlite',
                tokenSource: tokenInfo.source,
                note: sqlite.note,
                apiError: api ? `${api.error}${api.httpStatus ? ' (' + api.httpStatus + ')' : ''}` : tokenInfo.token ? null : null,
                allTimeUsd: sqlite.allTimeUsd,
                windows: sqlite.windows,
              })
            }
            const volc = await readVolcPlan()
            if (volc.ok && volc.data) {
              for (const item of volc.data.items || []) {
                if (!item.subscribed || item.product !== 'coding-plan') continue
                const vw = volcWindowsOf(item)
                if (vw.length > 0) {
                  providers.push({
                    id: 'volc-coding-plan',
                    name: '火山 CodingPlan',
                    plan: item.edition ?? null,
                    source: 'arkcli (GetCodingPlanUsage)',
                    updatedAtMs: typeof item.updated_at === 'number' ? item.updated_at : null,
                    windows: vw,
                  })
                }
              }
            }
            for (const plan of readCustomPlans()) {
              const r = await fetchCustomPlan(plan)
              if (r.ok && r.windows.length > 0) {
                providers.push({
                  id: plan.id,
                  name: plan.name,
                  plan: 'custom',
                  source: '自定义套餐 (' + plan.url + ')',
                  updatedAtMs: r.updatedAtMs,
                  windows: r.windows,
                })
              }
            }
            const dsKey = readDeepSeekKey()
            if (dsKey) {
              const b = await fetchDeepSeekBalance(dsKey)
              if (b.ok) {
                providers.push({
                  id: 'deepseek',
                  name: 'DeepSeek API',
                  plan: 'balance',
                  source: 'api.deepseek.com/user/balance',
                  updatedAtMs: b.updatedAtMs,
                  balance: {
                    currency: b.currency,
                    total: b.total,
                    granted: b.granted,
                    toppedUp: b.toppedUp,
                    isAvailable: b.isAvailable,
                  },
                })
              }
            }
            writeJson(res, 200, {
              ok: true,
              serverTimeMs: Date.now(),
              providers,
            })
            return
          }

          if (req.method === 'POST') {
            let payload
            try {
              payload = await readJsonBody(req)
            } catch {
              writeJson(res, 400, { ok: false, error: { code: 'bad-body', message: 'invalid JSON body' } })
              return
            }
            if (pathname === '/usage-dash/api/settings.get') {
              const ti = readGoToken()
              let goApi = { status: 'none', error: null }
              if (ti.token) {
                const r = await fetchGoUsage(ti.token)
                goApi = r.ok
                  ? { status: 'ok', httpStatus: r.httpStatus, windows: r.windows }
                  : { status: 'error', httpStatus: r.httpStatus, error: r.error }
              }
              const volcRes = await readVolcPlan()
              let volc = { status: 'error', error: 'unknown' }
              if (!volcRes.ok) {
                volc = { status: 'error', error: volcRes.error }
              } else {
                const coding = (volcRes.data && volcRes.data.items || []).find((i) => i.product === 'coding-plan')
                if (!coding) {
                  volc = { status: 'none', error: '未订阅 coding-plan' }
                } else if (!coding.subscribed) {
                  volc = { status: 'none', error: 'coding-plan 未订阅' }
                } else {
                  volc = {
                    status: 'ok',
                    edition: coding.edition ?? null,
                    updatedAtMs: typeof coding.updated_at === 'number' ? coding.updated_at : null,
                    windows: volcWindowsOf(coding),
                    itemError: coding.error ?? null,
                  }
                }
              }
              const custom = readCustomPlans().map(sanitizeCustomPlan)
              const dsKey = readDeepSeekKey()
              let deepseek = { keySet: false, keyHint: null, balance: { status: 'none', error: null } }
              if (dsKey) {
                deepseek.keySet = true
                deepseek.keyHint = hintOf(dsKey)
                const b = await fetchDeepSeekBalance(dsKey)
                deepseek.balance = b.ok
                  ? {
                      status: 'ok',
                      currency: b.currency,
                      total: b.total,
                      granted: b.granted,
                      toppedUp: b.toppedUp,
                      isAvailable: b.isAvailable,
                    }
                  : { status: 'error', error: b.error }
              }
              writeJson(res, 200, {
                ok: true,
                go: {
                  tokenSet: Boolean(ti.token),
                  tokenHint: ti.token ? hintOf(ti.token) : null,
                  tokenSource: ti.source,
                  api: goApi,
                },
                volc,
                custom,
                deepseek,
              })
              return
            }
            if (pathname === '/usage-dash/api/settings.set-deepseek-token') {
              const key = typeof payload.token === 'string' ? payload.token.trim() : ''
              if (!key || key.length < 8) {
                writeJson(res, 400, { ok: false, error: { code: 'bad-token', message: 'token too short' } })
                return
              }
              saveDeepSeekKey(key)
              invalidateDeepSeekCache()
              writeJson(res, 200, { ok: true, hint: hintOf(key) })
              return
            }
            if (pathname === '/usage-dash/api/settings.clear-deepseek-token') {
              clearDeepSeekKey()
              invalidateDeepSeekCache()
              writeJson(res, 200, { ok: true })
              return
            }
            if (pathname === '/usage-dash/api/settings.test-deepseek') {
              const custom = typeof payload.token === 'string' && payload.token.trim()
                ? payload.token.trim()
                : null
              const key = custom || readDeepSeekKey()
              if (!key) {
                writeJson(res, 200, { ok: false, error: 'no-token', message: '未配置 DeepSeek API key' })
                return
              }
              const b = await fetchDeepSeekBalance(key, true)
              writeJson(res, 200, b.ok
                ? { ok: true, currency: b.currency, total: b.total, granted: b.granted, toppedUp: b.toppedUp, isAvailable: b.isAvailable, hint: hintOf(key) }
                : { ok: false, error: b.error, hint: hintOf(key) })
              return
            }
            if (pathname === '/usage-dash/api/settings.custom-list') {
              writeJson(res, 200, { ok: true, custom: readCustomPlans().map(sanitizeCustomPlan) })
              return
            }
            if (pathname === '/usage-dash/api/settings.custom-add') {
              const name = typeof payload.name === 'string' ? payload.name.trim() : ''
              const url = typeof payload.url === 'string' ? payload.url.trim() : ''
              const token = typeof payload.token === 'string' ? payload.token.trim() : ''
              if (!name || !/^https?:\/\//i.test(url)) {
                writeJson(res, 400, { ok: false, error: { code: 'bad-plan', message: '需要套餐名称和 http(s) URL' } })
                return
              }
              const plans = readCustomPlans()
              plans.push({
                id: 'custom-' + Date.now().toString(36),
                name,
                url,
                token: token || undefined,
              })
              writeCustomPlans(plans)
              invalidateCustomCache()
              writeJson(res, 200, { ok: true, custom: plans.map(sanitizeCustomPlan) })
              return
            }
            if (pathname === '/usage-dash/api/settings.custom-remove') {
              const id = typeof payload.id === 'string' ? payload.id : ''
              const plans = readCustomPlans().filter((p) => p.id !== id)
              writeCustomPlans(plans)
              invalidateCustomCache()
              writeJson(res, 200, { ok: true, custom: plans.map(sanitizeCustomPlan) })
              return
            }
            if (pathname === '/usage-dash/api/settings.custom-refresh') {
              const id = typeof payload.id === 'string' ? payload.id : ''
              const plan = readCustomPlans().find((p) => p.id === id)
              if (!plan) {
                writeJson(res, 200, { ok: false, error: 'plan-not-found' })
                return
              }
              const r = await fetchCustomPlan(plan, true)
              writeJson(res, 200, r.ok
                ? { ok: true, windows: r.windows }
                : { ok: false, error: r.error })
              return
            }
            if (pathname === '/usage-dash/api/settings.volc-refresh') {
              const r = await readVolcPlan(true)
              if (!r.ok) {
                writeJson(res, 200, { ok: false, error: r.error })
                return
              }
              const coding = (r.data && r.data.items || []).find((i) => i.product === 'coding-plan')
              writeJson(res, 200, coding && coding.subscribed
                ? { ok: true, windows: volcWindowsOf(coding), edition: coding.edition ?? null, itemError: coding.error ?? null }
                : { ok: true, windows: [], error: 'coding-plan 未订阅或未返回数据' })
              return
            }
            if (pathname === '/usage-dash/api/settings.set-token') {
              const token = typeof payload.token === 'string' ? payload.token.trim() : ''
              if (!token || token.length < 8) {
                writeJson(res, 400, { ok: false, error: { code: 'bad-token', message: 'token too short' } })
                return
              }
              saveGoToken(token)
              invalidateGoApiCache()
              writeJson(res, 200, { ok: true, hint: hintOf(token) })
              return
            }
            if (pathname === '/usage-dash/api/settings.clear-token') {
              clearGoToken()
              invalidateGoApiCache()
              writeJson(res, 200, { ok: true })
              return
            }
            if (pathname === '/usage-dash/api/settings.test') {
              const custom = typeof payload.token === 'string' && payload.token.trim()
                ? payload.token.trim()
                : null
              const ti = custom ? { token: custom } : readGoToken()
              if (!ti.token) {
                writeJson(res, 200, { ok: false, error: 'no-token', message: '未配置 token（且本机 auth.json 无 opencode-go key）' })
                return
              }
              const r = await fetchGoUsage(ti.token, true)
              writeJson(res, 200, r.ok
                ? { ok: true, httpStatus: r.httpStatus, windows: r.windows, hint: hintOf(ti.token) }
                : { ok: false, httpStatus: r.httpStatus, error: r.error, hint: hintOf(ti.token) })
              return
            }
          }

          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown usage-dash API path' } })
        },
      }),
    'dsh-usage-dash: /usage-dash/api routes'
  )
}
