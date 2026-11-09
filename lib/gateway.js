/**
 * dsh-lan-connect — 门禁服务器
 *
 * 在局域网侧另起一个口，所有进来的人先过登录，过了之后反代到
 * 127.0.0.1 上的 dsh 本体。手机浏览器看到的 origin 就是这个门禁口，
 * 因此它发出的每一个请求（页面、/api、/plugins、SSE）都必然经过这里。
 *
 * 放行规则：
 *   - **本机回环**（socket 与 Host 都是回环）直接放行，等价于直连 dsh。
 *     本机用户本来就能开 127.0.0.1:3080，让门禁再来挡一次没有意义，
 *     而且会在自己机器上制造"打不开自己的 dsh"这种荒唐事。
 *   - 其余一律要求有效会话；没有就回登录页。
 *
 * 账号只能在**本机回环**上设置：否则任何一台连得上局域网的设备都能
 * 抢先在别人机器上开一个账号。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AccessGate, readCookie } from './gate.js'
import { proxyHttp, proxyUpgrade } from './proxy.js'

const LOGIN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'login.html')

/** 配对令牌失效时给手机看的页面（自包含，不依赖任何资源）。 */
const PAIR_EXPIRED_HTML = [
  '<!doctype html><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>配对码已失效</title>',
  '<body style="font:15px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
  'background:#0d1117;color:#e6edf3;padding:40px 22px;max-width:560px;margin:0 auto">',
  '<h2 style="margin:0 0 10px">这个配对码已经失效了</h2>',
  '<p style="color:#8b98a9">配对码只有两分钟有效期，刷新电脑上的管理页会生成新的。</p>',
  '<p style="color:#8b98a9">也可以直接刷新本页，用<strong>账号密码</strong>登录。</p>',
  '</body>',
].join('')

/** 还没设置访问密码时的提示（和"配对码过期"是两回事，必须分开说）。 */
const PAIR_NO_ACCOUNT_HTML = [
  '<!doctype html><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>还没设置访问密码</title>',
  '<body style="font:15px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
  'background:#0d1117;color:#e6edf3;padding:40px 22px;max-width:560px;margin:0 auto">',
  '<h2 style="margin:0 0 10px">这台 dsh 还没设置访问密码</h2>',
  '<p style="color:#8b98a9">扫码不是失效了——是门禁还没启用。请先在<strong>电脑上</strong>打开',
  '<code style="color:#a8d4ff">http://127.0.0.1:3099/</code> 设置账号和密码。</p>',
  '<p style="color:#8b98a9">设置完成后，重新扫一次二维码即可进入。</p>',
  '</body>',
].join('')

/** 登录请求体上限。 */
const MAX_LOGIN_BODY = 4 * 1024

/** 门禁自身的路径前缀。 */
export const GATE_PREFIX = '/__gate'

/** 判断 hostname 是否是回环。 */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname)
}

/** socket 是否来自回环。 */
function isLoopbackSocket(req) {
  const raw = req.socket?.remoteAddress
  if (typeof raw !== 'string') return false
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return addr === '::1' || addr === '127.0.0.1' || /^127\./.test(addr)
}

/**
 * 请求是否算"本机直连"。
 * socket 回环还不够——还有 DNS rebinding：攻击者把域名解析到 127.0.0.1，
 * 浏览器带着攻击者的 Host 打进来。所以两条都要满足。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否本机。
 */
export function isLocalRequest(req) {
  if (!isLoopbackSocket(req)) return false
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

/** 给浏览器看的小工具：请求是否在期待 JSON。 */
function wantsJson(req) {
  const accept = String(req.headers?.accept ?? '')
  const path = String(req.url ?? '')
  return accept.includes('application/json')
    || path.startsWith('/api/')
    || path.startsWith('/plugins/')
    || path.startsWith('/ext/')
}

/** 读一个小请求体。 */
async function readSmallBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_LOGIN_BODY) return ''
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 application/x-www-form-urlencoded。 */
function parseForm(text) {
  const out = {}
  for (const pair of String(text).split('&')) {
    if (pair === '') continue
    const at = pair.indexOf('=')
    const rawKey = at === -1 ? pair : pair.slice(0, at)
    const rawValue = at === -1 ? '' : pair.slice(at + 1)
    try {
      out[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      /* 忽略坏字段 */
    }
  }
  return out
}

/** 写响应。 */
function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * 门禁服务器。
 */
export class GateServer {
  /**
   * @param {{ port: number, dshPort: number, gate: AccessGate, makeInner: () => object, logger?: object }} options
   *   port 是对外监听口，dshPort 是 dsh 本体所在口。
   */
  constructor(options) {
    this.port = options.port
    this.dshPort = options.dshPort
    this.gate = options.gate
    this.makeInner = options.makeInner
    /** 配对令牌服务：用于"扫码免密进入"。缺省时该快捷方式自动不可用。 */
    this.pairing = options.pairing
    this.logger = options.logger ?? { info() {}, warn() {} }
    this.server = undefined
    this.inner = undefined
    /** 最近一次请求是否触发了"未登录"跳转（诊断用）。 */
    this.deniedCount = 0
  }

  /** 启动监听。 */
  async start() {
    this.inner = this.makeInner()
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.logger.warn?.(error)
        if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', '门禁内部错误\n')
        else res.destroy()
      })
    })
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head)
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.off('error', reject)
        this.server.on('error', (error) => { this.logger.warn?.(error) })
        resolve()
      })
    })
    return this.server.address()
  }

  /** 关闭监听并切断连接。 */
  async stop() {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  /** 登录页 HTML（缓存一次）。 */
  async loginPage() {
    if (this._loginHtml === undefined) {
      try {
        this._loginHtml = await readFile(LOGIN_FILE, 'utf8')
      } catch {
        this._loginHtml = '<!doctype html><meta charset="utf-8"><p>登录页缺失，请检查插件安装。</p>'
      }
    }
    return this._loginHtml
  }

  /** 主请求分发。 */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://gate.invalid')
    const pathname = url.pathname

    // ── 门禁自身的端点 ──────────────────────────────────────────────────
    if (pathname === `${GATE_PREFIX}/state`) {
      const local = isLocalRequest(req)
      send(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({
        needsSetup: !this.gate.hasAccount() && local,
        localOnlySetup: !this.gate.hasAccount() && !local,
        localPort: this.dshPort,
        sessionTtlMs: this.gate.sessionTtlMs,
      })}\n`)
      return
    }

    if (pathname === `${GATE_PREFIX}/login`) {
      await this.handleLogin(req, res)
      return
    }

    if (pathname === `${GATE_PREFIX}/logout`) {
      const token = readCookie(req.headers.cookie, AccessGate.cookieName)
      if (token !== undefined) this.gate.revokeSession(token)
      send(res, 200, 'application/json; charset=utf-8', '{"ok":true}\n',
        { 'set-cookie': this.clearCookie() })
      return
    }

    // ── 扫码免密进入：一次性配对令牌 ────────────────────────────────────
    // 手机扫的二维码指向这里。令牌由已登录的电脑在管理页上生成（2 分钟有效、
    // 刷新即换），拿它换一个门禁会话——这样"扫码"才算真的方便。
    // 注意两点：
    //   1. 必须已经设过账号才允许走这条路，否则还没配置的人会被别人先扫码进来；
    //   2. 免密只省掉"第一次"，会话到期后照样要输账号密码。
    if (pathname.startsWith(`${GATE_PREFIX}/pair/`)) {
      const id = decodeURIComponent(pathname.slice(`${GATE_PREFIX}/pair/`.length))
      // 两种情况要分开告诉用户，否则"还没设密码"会被误报成"配对码失效"，
      // 让人反复刷新二维码却始终进不去（实际踩过）。
      if (!this.gate.hasAccount()) {
        send(res, 410, 'text/html; charset=utf-8', PAIR_NO_ACCOUNT_HTML)
        return
      }
      if (this.pairing === undefined || !this.pairing.accept(id)) {
        send(res, 410, 'text/html; charset=utf-8', PAIR_EXPIRED_HTML)
        return
      }
      const session = this.gate.createSession(req)
      res.writeHead(303, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        location: '/',
        'set-cookie': this.sessionCookie(session.token),
      })
      res.end()
      return
    }

    // ── 本机直连：免登录 ────────────────────────────────────────────────
    if (isLocalRequest(req)) {
      // 例外：**还没设过账号**时，先引导设置。
      // 否则本机用户打开门禁口会直接被放行进入 GUI，永远找不到设置入口——
      // 这个坑实际踩过：装完打开 127.0.0.1:3099 只看到 dsh 界面，不知道去哪儿设密码。
      if (!this.gate.hasAccount()) {
        const setupHtml = await this.loginPage()
        send(res, 200, 'text/html; charset=utf-8', setupHtml)
        return
      }
      await this.forward(req, res)
      return
    }

    // ── 其余：必须有有效会话 ────────────────────────────────────────────
    const session = this.gate.sessionOf(req)
    if (session !== undefined) {
      await this.forward(req, res)
      return
    }

    // 未登录
    this.deniedCount += 1
    if (wantsJson(req)) {
      send(res, 401, 'application/json; charset=utf-8',
        '{"ok":false,"error":"需要先登录","login":"/__gate/state"}\n')
      return
    }
    const html = await this.loginPage()
    send(res, 200, 'text/html; charset=utf-8', html)
  }

  /** 处理登录 / 首次设置。 */
  async handleLogin(req, res) {
    if (req.method !== 'POST') {
      send(res, 405, 'application/json; charset=utf-8', '{"ok":false,"error":"method not allowed"}\n')
      return
    }
    const body = await readSmallBody(req)
    const form = parseForm(body)
    const user = String(form.user ?? '')
    const password = String(form.password ?? '')

    // 还未设置账号：只允许本机设置
    if (!this.gate.hasAccount()) {
      if (!isLocalRequest(req)) {
        send(res, 403, 'application/json; charset=utf-8',
          '{"ok":false,"error":"首次设置只能在这台电脑上进行（用 127.0.0.1 打开）"}\n')
        return
      }
      const result = this.gate.setAccount(user, password)
      if (!result.ok) {
        send(res, 400, 'application/json; charset=utf-8', `${JSON.stringify(result)}\n`)
        return
      }
      this.logger.info?.('lan-connect: 已设置访问账号')
    }

    const lock = this.gate.lockState(req)
    if (lock.locked) {
      send(res, 429, 'application/json; charset=utf-8',
        `${JSON.stringify({ ok: false, error: `尝试过于频繁，请 ${Math.ceil(lock.retryAfterMs / 1000)} 秒后再试` })}\n`)
      return
    }

    if (!this.gate.verifyCredentials(user, password)) {
      this.gate.noteFailure(req)
      send(res, 401, 'application/json; charset=utf-8', '{"ok":false,"error":"账号或密码不对"}\n')
      return
    }

    this.gate.clearFailures(req)
    const session = this.gate.createSession(req)
    send(res, 200, 'application/json; charset=utf-8',
      `${JSON.stringify({ ok: true, expiresAt: session.expiresAt })}\n`,
      { 'set-cookie': this.sessionCookie(session.token) })
  }

  /** 会话 cookie。HttpOnly + SameSite=Strict（登录跳转是同站，不受影响）。 */
  sessionCookie(token) {
    const maxAge = Math.floor(this.gate.sessionTtlMs / 1000)
    return `${AccessGate.cookieName}=${token}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; SameSite=Strict`
  }

  /** 清 cookie。 */
  clearCookie() {
    return `${AccessGate.cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
  }

  /** 转发给 dsh 本体。 */
  async forward(req, res) {
    await proxyHttp(req, res, { port: this.dshPort, inner: this.inner })
  }

  /** 协议升级转发：先查会话，再原样透传。 */
  async handleUpgrade(req, socket, head) {
    if (!isLocalRequest(req)) {
      const session = this.gate.sessionOf(req)
      if (session === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }
    proxyUpgrade(req, socket, head, { port: this.dshPort, inner: this.inner })
  }
}

export default GateServer
