/**
 * dsh-lan-connect — 访问门禁（账号密码 + 长周期会话）
 *
 * 这是"局域网访问要先登录"的那一层。设计要点：
 *
 * 1. **密码用 scrypt 哈希**，参数与盐一起存，方便以后调强度。绝不存明文，
 *    也绝不在任何响应里回显。校验用定长比较。
 * 2. **会话令牌 32 字节随机**，只存在服务端表里；客户端拿到的 cookie 就是
 *    令牌本身，服务端查表才知道它是否有效、是否过期。所以**撤销是即时的**
 *    ——这一点比 dsh 原生的浏览器凭据强（那是进程级签名密钥，热替换不了）。
 * 3. **绝对过期**：登录满 7 天就必须重验，不因为"一直在用"而续命。
 *    这正是"每个星期重新验证"的字面含义。想让常用设备免重验，把
 *    sessionTtlMs 调大即可，但语义就变成"多久不用才失效"了。
 * 4. **登录失败限速**：同一 IP 连续失败会进入冷却，避免门禁被在线爆破。
 * 5. 持久化原子写，且会话表落盘——否则每次重启 dsh 都要所有人重登，
 *    那"七天"就成了摆设。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 默认会话有效期：7 天（"每个星期重新验证"）。 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 会话令牌字节数（base64url 后约 43 字符）。 */
const TOKEN_BYTES = 32

/** scrypt 参数。N 越大越慢越安全；16384 在普通机器上是几十毫秒量级。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/** 同一 IP 连续失败多少次后进入冷却。 */
const MAX_FAILURES = 5

/** 触发限速后的冷却时长。 */
const LOCKOUT_MS = 60_000

/** 登录失败冷却表最多记多少条（防内存膨胀）。 */
const MAX_FAILURE_ENTRIES = 200

/** base64url 编码。 */
function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 解码 base64url（容错：缺填充也能解）。 */
function fromBase64url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - normalized.length % 4) % 4)
  return Buffer.from(normalized + padding, 'base64')
}

/** 定长比较，长度不同也走一次比较，不提前返回。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.byteLength !== right.byteLength) {
    // 仍然做一次比较以保持时间特征，然后返回 false
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/** 用给定盐和参数派生密码哈希。 */
function derive(password, salt, params) {
  return scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p })
}

/** 归一化 ip，用于限速表。 */
function ipOf(req) {
  const raw = req?.socket?.remoteAddress
  if (typeof raw !== 'string' || raw === '') return 'unknown'
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length)
  if (raw === '::1') return '127.0.0.1'
  return raw
}

/** 访问门禁。 */
export class AccessGate {
  /**
   * @param {{ dataFile?: string, sessionTtlMs?: number }} [options] - 可调项。
   */
  constructor(options = {}) {
    const ttl = Number(options.sessionTtlMs)
    this.sessionTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS
    /** @type {string | undefined} */
    this.dataFile = typeof options.dataFile === 'string' && options.dataFile !== '' ? options.dataFile : undefined
    /** @type {{ user: string, salt: string, hash: string, params: object } | undefined} */
    this.account = undefined
    /** @type {Map<string, { token: string, createdAt: number, expiresAt: number, lastSeen: number, ip: string, ua: string }>} */
    this.sessions = new Map()
    /** @type {Map<string, { fails: number, until: number }>} */
    this.failures = new Map()
    this.load()
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 读盘。文件缺失或损坏都当"没设过账号"，不抛。 */
  load() {
    if (this.dataFile === undefined || !existsSync(this.dataFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, 'utf8'))
      const account = parsed?.account
      if (account !== null && typeof account === 'object'
        && typeof account.user === 'string' && typeof account.salt === 'string' && typeof account.hash === 'string') {
        this.account = {
          user: account.user,
          salt: account.salt,
          hash: account.hash,
          params: account.params ?? { ...SCRYPT },
        }
      }
      const sessions = parsed?.sessions
      if (sessions !== null && typeof sessions === 'object') {
        const now = Date.now()
        for (const [token, value] of Object.entries(sessions)) {
          if (value === null || typeof value !== 'object') continue
          const expiresAt = Number(value.expiresAt) || 0
          if (expiresAt <= now) continue // 过期的不载入
          this.sessions.set(token, {
            token,
            createdAt: Number(value.createdAt) || now,
            expiresAt,
            lastSeen: Number(value.lastSeen) || now,
            ip: typeof value.ip === 'string' ? value.ip : 'unknown',
            ua: typeof value.ua === 'string' ? value.ua : '',
          })
        }
      }
    } catch {
      this.account = undefined
      this.sessions.clear()
    }
  }

  /** 原子写盘。 */
  save() {
    if (this.dataFile === undefined) return
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      const payload = JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        account: this.account ?? null,
        sessions: Object.fromEntries(this.sessions),
      }, null, 2)
      const temp = `${this.dataFile}.tmp`
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, this.dataFile)
    } catch {
      // 落盘失败不阻断访问；下次写再试
    }
  }

  // ── 账号 ──────────────────────────────────────────────────────────────────

  /** 是否已经设置过账号密码。 */
  hasAccount() {
    return this.account !== undefined
  }

  /**
   * 设置或重置账号密码。调用方必须**先确认请求来自本机回环**，
   * 否则任何局域网设备都能给自己开个账号。
   * @param {string} user - 账号名。
   * @param {string} password - 明文密码（只在内存里短暂存在）。
   * @returns {{ ok: true } | { ok: false, error: string }} 结果。
   */
  setAccount(user, password) {
    if (typeof user !== 'string' || user.trim() === '') return { ok: false, error: '账号不能为空' }
    if (typeof password !== 'string' || password.length < 6) return { ok: false, error: '密码至少 6 位' }
    if (password.length > 512) return { ok: false, error: '密码过长' }
    const salt = randomBytes(16)
    this.account = {
      user: user.trim(),
      salt: base64url(salt),
      hash: base64url(derive(password, salt, SCRYPT)),
      params: { ...SCRYPT },
    }
    // 改密码＝踢掉所有已登录设备，这是符合直觉的
    this.sessions.clear()
    this.save()
    return { ok: true }
  }

  /** 清掉账号（本机才能调用）。 */
  clearAccount() {
    this.account = undefined
    this.sessions.clear()
    this.save()
  }

  /**
   * 校验账号密码。
   * @param {string} user - 账号。
   * @param {string} password - 密码。
   * @returns {boolean} 是否匹配。
   */
  verifyCredentials(user, password) {
    const account = this.account
    if (account === undefined) return false
    if (typeof user !== 'string' || typeof password !== 'string') return false
    // 账号名也走定长比较，避免用响应时间区分"账号对不对"
    const userOk = safeEqual(user.trim(), account.user)
    const expected = fromBase64url(account.hash)
    const actual = derive(password, fromBase64url(account.salt), account.params ?? SCRYPT)
    const passOk = expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
    return userOk && passOk
  }

  // ── 登录限速 ──────────────────────────────────────────────────────────────

  /**
   * 这个 IP 是否正处于失败冷却中。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {{ locked: boolean, retryAfterMs: number }} 状态。
   */
  lockState(req) {
    const ip = ipOf(req)
    const entry = this.failures.get(ip)
    if (entry === undefined) return { locked: false, retryAfterMs: 0 }
    const left = entry.until - Date.now()
    if (left > 0) return { locked: true, retryAfterMs: left }
    // 注意：`until === 0` 表示"还没锁过"，这时条目里存的是**失败计数**，
    // 绝不能删——早先的写法在这里无条件 delete，导致计数每次归零、
    // 限速形同虚设（已由 test-gate.mjs 抓出）。
    // 只有"锁定刚刚到期"才清掉计数，让用户重新获得完整的尝试次数。
    if (entry.until !== 0) this.failures.delete(ip)
    return { locked: false, retryAfterMs: 0 }
  }

  /** 记一次登录失败，达到阈值就进入冷却。 */
  noteFailure(req) {
    const ip = ipOf(req)
    const entry = this.failures.get(ip) ?? { fails: 0, until: 0 }
    entry.fails += 1
    if (entry.fails >= MAX_FAILURES) {
      entry.until = Date.now() + LOCKOUT_MS
      entry.fails = 0
    }
    this.failures.set(ip, entry)
    // 防内存膨胀：超量就丢掉最早的一批
    if (this.failures.size > MAX_FAILURE_ENTRIES) {
      const first = this.failures.keys().next()
      if (!first.done) this.failures.delete(first.value)
    }
  }

  /** 登录成功，清掉该 IP 的失败计数。 */
  clearFailures(req) {
    this.failures.delete(ipOf(req))
  }

  // ── 会话 ──────────────────────────────────────────────────────────────────

  /** 会话 cookie 名。 */
  static get cookieName() {
    return 'dsh-lan-access'
  }

  /**
   * 登录成功后开一个新会话。
   * @param {import('node:http').IncomingMessage} req - 请求（取 IP / UA）。
   * @returns {{ token: string, expiresAt: number }} 令牌与到期时间。
   */
  createSession(req) {
    const now = Date.now()
    const token = base64url(randomBytes(TOKEN_BYTES))
    const session = {
      token,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      lastSeen: now,
      ip: ipOf(req),
      ua: String(req?.headers?.['user-agent'] ?? '').slice(0, 200),
    }
    this.sessions.set(token, session)
    this.save()
    return { token, expiresAt: session.expiresAt }
  }

  /**
   * 校验一个会话令牌，并顺手更新 lastSeen。
   * 过期即删除——绝对过期，不续命。
   * @param {unknown} token - 令牌。
   * @returns {object | undefined} 有效则返回会话记录。
   */
  checkSession(token) {
    if (typeof token !== 'string' || token === '') return undefined
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    const now = Date.now()
    if (session.expiresAt <= now) {
      this.sessions.delete(token)
      this.save()
      return undefined
    }
    session.lastSeen = now
    return session
  }

  /**
   * 从 Cookie 头里取出会话令牌并校验。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {object | undefined} 有效会话。
   */
  sessionOf(req) {
    return this.checkSession(readCookie(req?.headers?.cookie, AccessGate.cookieName))
  }

  /**
   * 给一个有效会话续期：把到期时间推后一整个周期。
   *
   * 这是"7 天绝对过期"的**有意例外**。绝对过期的意义是"每周必须重新确认一次"，
   * 而用户主动点「续期」正是明确表达了"这台设备我还在用"——那属于重新确认，
   * 不是被悄悄续命。所以这里**不做滑动过期**（每次访问自动延期），
   * 只提供一个需要人手动触发的续期入口。
   *
   * @param {unknown} token - 会话令牌。
   * @returns {{ expiresAt: number } | undefined} 新的到期时间；会话无效时 undefined。
   */
  renewSession(token) {
    const session = this.checkSession(token)
    if (session === undefined) return undefined
    const now = Date.now()
    session.expiresAt = now + this.sessionTtlMs
    session.lastSeen = now
    this.save()
    return { expiresAt: session.expiresAt }
  }

  /** 撤销一个会话。 */
  revokeSession(token) {
    const removed = this.sessions.delete(token)
    if (removed) this.save()
    return removed
  }

  /** 撤销全部会话（所有人下次访问都要重登）。 */
  revokeAll() {
    const n = this.sessions.size
    this.sessions.clear()
    this.save()
    return n
  }

  /** 活跃会话列表（给管理面看）。 */
  listSessions() {
    const now = Date.now()
    const rows = []
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token)
        continue
      }
      rows.push({
        token,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeen: session.lastSeen,
        ip: session.ip,
        ua: session.ua,
      })
    }
    return rows.sort((a, b) => b.lastSeen - a.lastSeen)
  }
}

/**
 * 从 Cookie 头里读一个值。只做最小解析，不实现通用 Cookie 语法。
 * @param {unknown} header - Cookie 头原始值。
 * @param {string} name - cookie 名。
 * @returns {string | undefined} 值。
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

export default AccessGate
