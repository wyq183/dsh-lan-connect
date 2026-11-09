/**
 * dsh-lan-connect — 门禁反向代理
 *
 * 门禁通过之后，把请求转发到 127.0.0.1 上的 dsh 本体。
 *
 * 为什么是"另一个端口 + 反代"而不是"同端口加路径前缀"：
 *   页面里的 `/api`、`/plugins/...` 全是绝对路径。加前缀的话，浏览器发出的
 *   请求不会带上前缀，一个个重写既脆弱又容易漏。换成独立端口，手机浏览器
 *   看到的 origin 就是门禁端口，**所有请求天然全部经过门禁**，路径无需改写。
 *
 * 内部凭据（inner auth）：dsh 的 /api 要一个 authority 绑定的签名 cookie，
 * 而反代发出的请求 Host 是 127.0.0.1，需要一个为 127.0.0.1 签发的 cookie。
 * 做法是拿 connection.authenticatedUrl() 生成的那条一次性链接去兑换一次
 * （和每台配对设备首次导航做的事完全一样），把 Set-Cookie 缓存起来复用；
 * 上游回 401 就丢掉缓存重新兑换。
 *
 * 关键性质：**手机永远拿不到 dsh 的进程令牌**，它只有自己的门禁 cookie。
 * 所以撤销一台设备是即时生效的——门禁这一层是我们自己的表。
 */

import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

/**
 * 从 Set-Cookie 里抽出 `name=value` 部分（丢掉属性），并只保留我们关心的那一条。
 * @param {string[] | string | undefined} setCookie - 上游的 Set-Cookie。
 * @returns {string | undefined} 形如 `dsh-auth-xxx=v1.…` 的 cookie 对。
 */
function cookiePairFrom(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (typeof setCookie === 'string' ? [setCookie] : [])
  for (const raw of list) {
    const pair = String(raw).split(';')[0]?.trim()
    if (pair !== undefined && pair !== '' && pair.includes('=')) return pair
  }
  return undefined
}

/**
 * 内部凭据句柄：懒兑换、可失效、可重取。
 */
export class InnerAuth {
  /**
   * @param {() => string | undefined} launchUrl - 返回 dsh 的一次性登录链接。
   * @param {typeof fetch} [fetchImpl] - 可注入（测试用）。
   */
  constructor(launchUrl, fetchImpl) {
    this.launchUrl = launchUrl
    this.fetch = fetchImpl ?? fetch
    /** @type {string | undefined} */
    this.cookie = undefined
    /** @type {Promise<string | undefined> | undefined} */
    this.pending = undefined
  }

  /**
   * 取得内部凭据 cookie（`name=value`）。并发调用只兑换一次。
   * @returns {Promise<string | undefined>} cookie 对；兑换不到时 undefined。
   */
  async ready() {
    if (this.cookie !== undefined) return this.cookie
    if (this.pending !== undefined) return this.pending
    this.pending = this.redeem().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** 真正去兑换一次。 */
  async redeem() {
    const url = this.launchUrl()
    if (typeof url !== 'string' || url === '') return undefined
    try {
      const res = await this.fetch(url, { redirect: 'manual' })
      const pair = cookiePairFrom(res.headers.getSetCookie?.() ?? res.headers.get('set-cookie'))
      if (pair === undefined) return undefined
      this.cookie = pair
      return pair
    } catch {
      return undefined
    }
  }

  /** 丢弃缓存；下次 ready() 会重新兑换。 */
  invalidate() {
    this.cookie = undefined
  }
}

/** 把内部凭据并进外来的 Cookie 头（同名则内部优先）。 */
function mergeCookie(existing, inner) {
  if (inner === undefined) return existing
  const innerName = inner.split('=')[0]
  const kept = []
  if (typeof existing === 'string' && existing !== '') {
    for (const segment of existing.split(';')) {
      const trimmed = segment.trim()
      if (trimmed === '') continue
      if (trimmed.split('=')[0] === innerName) continue // 同名丢掉，避免歧义
      kept.push(trimmed)
    }
  }
  kept.push(inner)
  return kept.join('; ')
}

/** 转发时要去掉的逐跳头（RFC 7230 §6.1）。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * 转发前必须抹掉的"来源类"头。
 *
 * 这些头描述的是**外部**的 origin（比如 `http://192.168.1.11:3099`），
 * 一旦原样带到回环上游，dsh 的 Origin / Sec-Fetch 围栏就会看到
 * "origin=192.168.1.11:3099 而 host=127.0.0.1:3080" —— 判定为跨站，直接 403。
 *
 * 实测后果很严重：WebSocket 升不上去（/api/remote.mux 返回 403），
 * 前端一直显示「自动重连中」，侧边栏「暂无会话」——
 * 看起来像"聊天记录丢了"，其实是实时通道根本没连上。
 *
 * 抹掉之后补一个 `sec-fetch-site: same-origin`：请求确实是我们自己
 * 在回环上重新发起的，标记成同源才符合事实。
 * （`@linxin666/dsh-remote-web-ui` 的 loopback-proxy 也是这么做的。）
 */
const ORIGIN_MARKERS = new Set([
  'origin', 'referer',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
])

/**
 * 把一次 HTTP 请求转发到 dsh 本体。
 *
 * @param {import('node:http').IncomingMessage} req - 外部请求。
 * @param {import('node:http').ServerResponse} res - 外部响应。
 * @param {{ port: number, inner?: InnerAuth }} options - 目标端口与内部凭据。
 * @returns {Promise<void>} 转发结束（或失败后已回 502）。
 */
export function proxyHttp(req, res, options) {
  const { port, inner } = options
  return (async () => {
    const innerCookie = inner === undefined ? undefined : await inner.ready()

    /** @type {Record<string, string | string[]>} */
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      // 来源类头一律丢掉，否则上游按跨站处理（见 ORIGIN_MARKERS 的说明）
      if (ORIGIN_MARKERS.has(lower)) continue
      headers[name] = value
    }
    // Host 必须是回环：dsh 的 Host 围栏以此判定"这是本机请求"
    headers.host = `127.0.0.1:${String(port)}`
    // 请求确实是在回环上重新发起的，标成同源才符合事实
    headers['sec-fetch-site'] = 'same-origin'
    headers.cookie = mergeCookie(req.headers.cookie, innerCookie) ?? ''
    if (headers.cookie === '') delete headers.cookie

    return await new Promise((resolve) => {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers,
      }, (up) => {
        // 上游 401：说明内部凭据过期/失效，丢掉缓存并原样回报。
        // 不自动重试——重试会让 POST 有被重复执行的风险。
        if (up.statusCode === 401 && inner !== undefined) inner.invalidate()

        /** @type {Record<string, string | string[]>} */
        const outHeaders = {}
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(name.toLowerCase())) continue
          outHeaders[name] = value
        }
        res.writeHead(up.statusCode ?? 502, outHeaders)
        // SSE / 长响应：直接管道，不缓冲，不设超时
        up.pipe(res)
        up.on('end', resolve)
        up.on('error', () => { res.destroy(); resolve() })
      })

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('dsh-lan-connect: 无法连接到 dsh 本体（127.0.0.1）\n')
        } else {
          res.destroy()
        }
        resolve()
      })

      // 请求体直接流过去（上传大文件也不吃内存）
      req.pipe(upstream)
      req.on('error', () => { upstream.destroy(); resolve() })
    })
  })()
}

/**
 * 把一次协议升级（WebSocket 等）转发到 dsh 本体。
 * 用裸 socket 重放握手，因为 node:http 的 request() 不直接支持 upgrade。
 *
 * @param {import('node:http').IncomingMessage} req - 外部 upgrade 请求。
 * @param {import('node:stream').Duplex} socket - 外部 socket。
 * @param {Buffer} head - 已经读掉的字节。
 * @param {{ port: number, inner?: InnerAuth }} options - 目标端口与内部凭据。
 */
export function proxyUpgrade(req, socket, head, options) {
  const { port, inner } = options
  void (async () => {
    const innerCookie = inner === undefined ? undefined : await inner.ready()
    const upstream = netConnect(port, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      const seen = new Set()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        const lower = name.toLowerCase()
        if (lower === 'host') continue
        // 和 HTTP 转发同理：来源类头会把上游判成跨站，WebSocket 直接 403
        if (ORIGIN_MARKERS.has(lower)) continue
        seen.add(lower)
        for (const single of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${single}`)
        }
      }
      lines.push(`Host: 127.0.0.1:${String(port)}`)
      lines.push('Sec-Fetch-Site: same-origin')
      const merged = mergeCookie(req.headers.cookie, innerCookie)
      if (merged !== undefined) {
        // cookie 已经在上面的循环里写过就换成合并后的值
        if (seen.has('cookie')) {
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].toLowerCase().startsWith('cookie:')) lines.splice(i, 1)
          }
        }
        lines.push(`Cookie: ${merged}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head !== undefined && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })

    upstream.on('error', () => { socket.destroy() })
    socket.on('error', () => { upstream.destroy() })
    socket.on('close', () => { upstream.destroy() })
  })()
}

export default { proxyHttp, proxyUpgrade, InnerAuth }
