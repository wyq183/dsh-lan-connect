/**
 * dsh-lan-connect — HTTP 路由层
 *
 * 挂在 `/ext/lan-connect` 下的所有端点。除 `/pair/<id>` 外，认证统一走 dsh 自己的
 * `ctx.connection.requestRejection(req)`：
 *   - 浏览器会话 cookie 是 `SameSite=Strict` 且按 authority 命名，
 *     所以跨站请求（CSRF）与 DNS rebinding 都拿不到有效认证；
 *   - 未认证一律 401，令牌本身不会被吐给外面。
 *
 * 端点：
 *   GET  /ext/lan-connect/               管理页
 *   GET  /ext/lan-connect/api/state      当前状态（地址/入口/设备/配对）
 *   POST /ext/lan-connect/api/heartbeat  设备心跳
 *   POST /ext/lan-connect/api/pair/issue 重新签发配对令牌（刷新二维码）
 *   POST /ext/lan-connect/api/rotate     轮换签名密钥（换锁）
 *   GET  /ext/lan-connect/api/gate/control   门禁启停状态（v0.2.0）
 *   POST /ext/lan-connect/api/gate/control   运行期启停门禁口（v0.2.0）
 *   GET  /ext/lan-connect/qr.svg         二维码 SVG（?i=N 选地址，?l=1 选本机）
 *   GET  /ext/lan-connect/pair/<id>      ★ 唯一免认证端点：校验配对令牌后
 *                                        303 跳到真正带 launch token 的地址
 *
 * ⚠ v0.2.0 移除了旧版的 `GET|POST /api/config/lan`（改写 profile patch 的
 *   webserver.host 让 dsh 本体对外监听）。桌面端本体必须保持回环，
 *   那个开关既做不到、又会把门禁变成摆设。取而代之的是上面那对门禁启停端点。
 *
 * 关于 /pair/<id> 为什么必须免认证：手机第一次进来时什么都没有，它唯一持有的
 * 就是二维码里的那个短时令牌。这正是一次"配对"该有的样子。安全性来自令牌本身
 * （32 字节随机、2 分钟过期、刷新即换），而不是来自已有会话。
 */

import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 本插件占用的路由前缀。 */
export const ROUTE_PATH = '/ext/lan-connect'

/** 管理页 HTML 的位置（相对本文件：lib/ → ../ui/index.html）。 */
const UI_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html')

/** 浏览器会话签名密钥在凭据库里的地址。与 client-connection 的 browser-auth 保持一致。 */
const BROWSER_SESSION_KEY = 'client-connection/browser-session'

/** 凭据载荷版本，见 credentials 的 GrantRecord 约定。 */
const STORED_SECRET_VERSION = 1

/** 与 dsh 的 browser-auth 相同的密钥长度。 */
const SECRET_BYTES = 32

/** 响应体上限，避免 heartbeat 之类被灌爆。 */
const MAX_BODY_BYTES = 8 * 1024

/** 二维码模块的懒加载缓存（模块缺失时不影响页面其余功能）。 */
let qrModulePromise

/**
 * 懒加载二维码模块。加载失败时返回 null，让二维码那一块优雅降级。
 * @returns {Promise<{ qrSvg?: Function } | null>} 模块或 null。
 */
function loadQrModule() {
  if (qrModulePromise === undefined) {
    qrModulePromise = import('./qr.js').catch(() => null)
  }
  return qrModulePromise
}

/** 私网 IPv4 判定：局域网里手机能直接连的通常是这几段。 */
function isPrivateV4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** 回环地址判定（含 IPv6 形态）。 */
function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
    || /^127\./.test(hostname)
}

/**
 * 枚举本机所有可用于局域网访问的 IPv4 地址。
 * 跳过回环、链路本地（169.254.*）与内部接口。私网段排前面——VPN / 虚拟网卡的
 * 地址手机多半连不上，排后面但仍列出来供判断。
 * @returns {Array<{iface: string, address: string, private: boolean, recommended: boolean}>} 地址表。
 */
export function listLanAddresses() {
  const found = []
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal === true) continue
      if (item.address.startsWith('169.254.')) continue
      found.push({ iface, address: item.address, private: isPrivateV4(item.address), recommended: false })
    }
  }
  found.sort((a, b) => {
    if (a.private !== b.private) return a.private ? -1 : 1
    return a.address.localeCompare(b.address)
  })
  if (found.length > 0) found[0].recommended = true
  return found
}

/** 生成一个与 dsh 内部格式一致的 base64url 随机密钥。 */
function randomSecret() {
  return randomBytes(SECRET_BYTES).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** 写一个纯文本/JSON 响应。 */
function send(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
}

/** 读请求体（小上限），拿不到就返回空串。 */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) return ''
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 决定配对成功后该跳到哪个 authority。
 *
 * 安全要点：重定向目标**不能**照抄请求里的 Host，否则就是一个开放重定向
 * （攻击者构造 `Host: evil.com` 的请求，就能把扫码的人带去别处）。
 * 这里只接受"确实属于本机"的 authority：回环，或本机枚举得到的局域网地址。
 * 认不出来就返回 undefined，由调用方用第一个局域网地址兜底。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} port - 当前监听端口。
 * @returns {string | undefined} 形如 `192.168.1.13:3080` 的 authority。
 */
function safePairAuthority(req, port) {
  const raw = req.headers?.host
  if (typeof raw !== 'string' || raw === '') return undefined
  let hostname
  try {
    // 用 WHATWG 解析，挡掉 `evil.com@192.168.1.13` 之类的花招
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return undefined
  }
  if (isLoopbackHost(hostname)) return `127.0.0.1:${String(port)}`
  const known = listLanAddresses().some(item => item.address === hostname)
  if (!known) return undefined
  return `${hostname}:${String(port)}`
}

/**
 * 组装当前状态快照。
 * @param {object} deps - 依赖。
 * @returns {Promise<object>} 状态对象。
 */
async function buildState({ ctx, connection, tracker, pairing, req, allowIssue = false, gate, gateState, dshPort }) {
  // 顺序要紧：先登记这次访问，再取设备列表。
  // 反过来的话，第一次打开管理页时列表里看不到自己。
  const self = tracker.touch(req, { path: ROUTE_PATH })

  const webServer = ctx.webServer
  const port = webServer.port
  const bindHost = webServer.host
  const lanEnabled = bindHost === '0.0.0.0'

  const loopbackUrl = connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`)

  // 只有"页面刚打开"这一类请求才允许自动签发配对码。
  // 后台轮询绝不能触发签发——否则页面开着不动就等于配对码永不过期，
  // 那 TTL 就是摆设了。过期的码就让它过期，由用户点「重新生成」。
  if (allowIssue && pairing.current() === undefined) pairing.issue()

  // 局域网入口全部走**门禁口**：
  //   pairUrl —— 二维码内容，指向门禁的扫码免密端点（2 分钟有效、刷新即换）
  //   gateUrl —— 给其他电脑直接输入的网址（要输账号密码，7 天免再输）
  // 注意：不能再指向 dsh 本体的端口。本体改成只绑回环之后，局域网根本到不了它，
  // 二维码若还写 3080，手机扫码就会失败（这个坑是改 host 时引入的）。
  const token = pairing.current()
  const gateInfo = typeof gateState === 'function' ? gateState() : {}
  const gatePort = Number.isFinite(Number(gateInfo.port)) ? Number(gateInfo.port) : undefined
  // 注意：这里**不能**再看 lanEnabled（本体是否绑 0.0.0.0）。
  // 门禁起来之后，本体本来就该只在回环上、由门禁口承担局域网访问；
  // 若仍用 lanEnabled 过滤，就会出现"配置正确时反而一个入口都不列"的荒唐结果。
  // 判断依据应该是**门禁有没有在跑**（gatePort 拿不到就说明没跑）。
  const addresses = gatePort !== undefined
    ? listLanAddresses().map(item => ({
      ...item,
      gateUrl: `http://${item.address}:${String(gatePort)}/`,
      pairUrl: token === undefined
        ? undefined
        : `http://${item.address}:${String(gatePort)}/__gate/pair/${token.id}`,
    }))
    : []

  return {
    bindHost,
    port,
    lanEnabled,
    loopbackUrl,
    addresses,
    devices: tracker.list(),
    deviceTtlMs: tracker.ttlMs,
    currentIp: self.ip,
    pair: token === undefined
      ? { active: false }
      : { active: true, issuedAt: token.issuedAt, expiresAt: token.expiresAt, remainingMs: token.remainingMs },
    gate: {
      // 门禁自身的运行状态（端口、是否起来、失败原因）
      ...(typeof gateState === 'function' ? gateState() : {}),
      /** dsh 本体是否仍暴露在局域网 —— 为真则门禁可被绕过 */
      dshExposedOnLan: bindHost === '0.0.0.0',
      dshPort,
      hasAccount: gate?.hasAccount?.() ?? false,
      sessionTtlMs: gate?.sessionTtlMs,
      sessions: gate?.listSessions?.() ?? [],
    },
  }
}

/**
 * 建立 `/ext/lan-connect` 的请求处理器。
 * @param {{ ctx: object, connection: object, tracker: object, pairing: object }} deps - 依赖。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器。
 */
export function createLanConnectHandler({ ctx, connection, tracker, pairing, gate, gateState, dshPort, gateControl }) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.invalid')
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'bad request\n')
      return
    }
    const pathname = url.pathname
    const method = req.method ?? 'GET'
    const sub = pathname.slice(ROUTE_PATH.length) || '/'

    try {
      // ── ★ 配对端点：唯一免认证的入口 ──────────────────────────────────────
      // 手机第一次进来只带着二维码里的短时令牌，这里校验通过后把它送到
      // 真正带 launch token 的地址。过期/不存在返回同样的 410，不给探测口。
      if (method === 'GET' && sub.startsWith('/pair/')) {
        const id = decodeURIComponent(sub.slice('/pair/'.length))
        if (!pairing.accept(id)) {
          send(res, 410, 'text/html; charset=utf-8', [
            '<!doctype html><meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<title>配对码已失效</title>',
            '<body style="font:15px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
            'background:#0d1117;color:#e6edf3;padding:40px 22px;max-width:560px;margin:0 auto">',
            '<h2 style="margin:0 0 10px">这个配对码已经失效了</h2>',
            '<p style="color:#8b98a9">配对码只有两分钟有效期，刷新管理页会生成新的。</p>',
            '<p style="color:#8b98a9">请在电脑上打开 <code>/ext/lan-connect/</code> 重新扫码。</p>',
            '</body>',
          ].join(''))
          return
        }
        const authority = safePairAuthority(req, ctx.webServer.port)
          ?? `${listLanAddresses()[0]?.address ?? '127.0.0.1'}:${String(ctx.webServer.port)}`
        const target = connection.authenticatedUrl(`http://${authority}`)
        tracker.touch(req, { path: '/（扫码配对）', viaPair: true })
        res.writeHead(303, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          location: target,
        })
        res.end()
        return
      }

      // ── 其余端点都要求已认证 ──────────────────────────────────────────────
      let rejection
      try {
        rejection = connection.requestRejection(req)
      } catch {
        rejection = 401
      }
      if (rejection !== undefined) {
        send(res, rejection, 'text/plain; charset=utf-8',
          rejection === 401 ? 'dsh-lan-connect: 需要先在本机浏览器认证\n' : 'forbidden\n')
        return
      }

      // ── 管理页 ────────────────────────────────────────────────────────────
      if (method === 'GET' && (sub === '/' || sub === '/index.html')) {
        let html
        try {
          html = await readFile(UI_FILE, 'utf8')
        } catch (error) {
          send(res, 500, 'text/plain; charset=utf-8', `无法读取管理页: ${String(error?.message ?? error)}\n`)
          return
        }
        send(res, 200, 'text/html; charset=utf-8', html)
        return
      }

      // ── 状态 ──────────────────────────────────────────────────────────────
      // ?issue=1 表示"这是页面刚打开"，允许自动签发一张配对码；
      // 后台轮询不带这个参数，于是过期就是过期。
      if (method === 'GET' && sub === '/api/state') {
        const allowIssue = url.searchParams.get('issue') === '1'
        sendJson(res, 200, await buildState({ ctx, connection, tracker, pairing, req, allowIssue, gate, gateState, dshPort }))
        return
      }

      // ── 重新签发配对令牌（刷新二维码）──────────────────────────────────────
      if (method === 'POST' && sub === '/api/pair/issue') {
        await readBody(req)
        const token = pairing.issue()
        sendJson(res, 200, {
          ok: true,
          expiresAt: token.expiresAt,
          remainingMs: pairing.tokenTtlMs,
        })
        return
      }

      // ── 心跳：客户端插件定时上报，用来判断"谁在线" ─────────────────────────
      if (method === 'POST' && sub === '/api/heartbeat') {
        await readBody(req)
        const entry = tracker.touch(req, { path: '/（GUI 会话）' })
        sendJson(res, 200, { ok: true, ip: entry.ip, online: tracker.list().length })
        return
      }

      // ── 换锁：轮换签名密钥，让已发出的 cookie 在下次启动后全部失效 ──────────
      if (method === 'POST' && sub === '/api/rotate') {
        await readBody(req)
        const credentials = ctx.get('credentials')
        if (credentials === undefined) {
          sendJson(res, 503, { ok: false, error: '凭据服务不可用，无法轮换密钥' })
          return
        }
        const secret = randomSecret()
        await credentials.modifyRecord(BROWSER_SESSION_KEY, async () => ({
          kind: 'grant',
          payload: { version: STORED_SECRET_VERSION, secret },
        }))
        pairing.clear()
        tracker.clear()
        sendJson(res, 200, {
          ok: true,
          // 关键事实：内存里的签名密钥不可热替换，所以旧 cookie 要到下次启动才真正失效。
          effective: 'next-start',
          message: '签名密钥已轮换，配对令牌也已撤销。重启 dsh 后，所有已配对的设备都需要重新扫码。',
        })
        return
      }

      // ── 门禁会话：列出 / 撤销 ──────────────────────────────────────────────
      // 这一层的撤销是**即时**的：会话表在我们自己手里，删掉即失效。
      // （对比之下，dsh 原生的浏览器凭据是进程级签名密钥，热替换不了。）
      if (method === 'GET' && sub === '/api/gate/sessions') {
        sendJson(res, 200, {
          ok: true,
          sessionTtlMs: gate?.sessionTtlMs,
          sessions: gate?.listSessions?.() ?? [],
        })
        return
      }

      if (method === 'POST' && sub === '/api/gate/revoke') {
        await readBody(req)
        const target = url.searchParams.get('token')
        if (typeof target === 'string' && target !== '') {
          const removed = gate?.revokeSession?.(target) ?? false
          sendJson(res, 200, { ok: true, removed })
          return
        }
        const revoked = gate?.revokeAll?.() ?? 0
        sendJson(res, 200, { ok: true, revoked })
        return
      }

      // ── 会话续期：把到期时间推后一个周期 ──────────────────────────────────
      // 这是"7 天绝对过期"的有意例外——主动点续期＝明确表达"这台我还在用"。
      // 注意它不是滑动过期：不点就不续。
      if (method === 'POST' && sub === '/api/gate/renew') {
        await readBody(req)
        const target = url.searchParams.get('token')
        if (typeof target !== 'string' || target === '') {
          sendJson(res, 400, { ok: false, error: '缺少 token' })
          return
        }
        const renewed = gate?.renewSession?.(target)
        if (renewed === undefined) {
          sendJson(res, 404, { ok: false, error: '会话不存在或已过期，需要重新登录' })
          return
        }
        sendJson(res, 200, { ok: true, expiresAt: renewed.expiresAt })
        return
      }

      // ── 门禁开关：运行期启停门禁口 ────────────────────────────────────────
      // v0.2.0 用这个取代了旧版「改写 profile patch 里的 webserver.host」的开关。
      // 旧做法在桌面端不能用（本体必须保持回环，见 lib/index.js 顶部说明），
      // 而启停门禁口是运行期操作——立即生效、不需要重启。
      if (method === 'GET' && sub === '/api/gate/control') {
        sendJson(res, 200, { ok: true, ...(gateControl?.state?.() ?? { available: false }) })
        return
      }

      if (method === 'POST' && sub === '/api/gate/control') {
        const body = await readBody(req)
        let enabled
        try {
          enabled = JSON.parse(body === '' ? '{}' : body)?.enabled
        } catch {
          enabled = undefined
        }
        if (typeof enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: '请求体需要 {"enabled": true|false}' })
          return
        }
        if (gateControl === undefined) {
          sendJson(res, 503, { ok: false, error: '门禁控制器不可用，无法启停' })
          return
        }
        try {
          await (enabled ? gateControl.start() : gateControl.stop())
          sendJson(res, 200, { ok: true, ...(gateControl.state?.() ?? {}) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      // ── 二维码 ────────────────────────────────────────────────────────────
      if (method === 'GET' && sub === '/qr.svg') {
        const state = await buildState({ ctx, connection, tracker, pairing, req, gate, gateState, dshPort })
        let target
        if (url.searchParams.get('l') === '1') {
          target = state.loopbackUrl
        } else {
          const index = Number.parseInt(url.searchParams.get('i') ?? '0', 10)
          const picked = state.addresses[Number.isInteger(index) ? index : 0]
          target = picked?.pairUrl
        }
        if (target === undefined) {
          send(res, 404, 'text/plain; charset=utf-8', '没有可用的局域网地址（或配对码已过期，请刷新页面）\n')
          return
        }
        const qr = await loadQrModule()
        if (qr?.qrSvg === undefined) {
          send(res, 503, 'text/plain; charset=utf-8', '二维码模块不可用\n')
          return
        }
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
        })
        // margin 是静默区宽度（单位：模块）。ISO/IEC 18004 要求 ≥4，
        // 低于这个值很多扫描器（尤其手机在弱光下）会识别困难。
        res.end(qr.qrSvg(target, { size: 260, margin: 4, ecLevel: 'M' }))
        return
      }

      send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
    } catch (error) {
      ctx.logger?.warn?.(error)
      if (res.headersSent) {
        res.destroy()
        return
      }
      send(res, 500, 'text/plain; charset=utf-8', `内部错误: ${String(error?.message ?? error)}\n`)
    }
  }
}
