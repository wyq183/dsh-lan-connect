/**
 * dsh-lan-connect — 配对令牌
 *
 * 解决的问题：如果二维码里直接放 dsh 的 launch token，那张码就是**永久钥匙** ——
 * 谁拍了照（同事、路人、相册同步）谁就永久能进这台机器，直到 dsh 重启。
 *
 * 这里改成两层：
 *   1. 页面上刷出的二维码只包含一个**短时配对令牌**（默认 120 秒）。
 *   2. 手机扫到的地址是 /ext/lan-connect/pair/<id>，服务端校验通过后，
 *      才 303 跳到真正带 launch token 的地址。
 *
 * 于是二维码截图在两分钟后就作废，而重启前的正常使用完全不受影响。
 *
 * 设计取舍：
 *   - 同一时刻只有一个有效令牌，刷新二维码会让上一张立刻失效。
 *   - 令牌在过期前**可以重复使用**。手机扫码的流程经常跨 cookie 上下文
 *     （相机预览 → 应用内浏览器 → 系统浏览器），后一个上下文必须能用同一张码
 *     完成自己的配对，否则用户会看到"扫了没反应"。
 *   - 令牌只存在内存里，进程重启即失效——这是有意的：一个重启后还活着的
 *     配对令牌，等于把"重启能收回钥匙"这个性质也一起丢掉了。
 *   - 与真实令牌的比对用定长比较，且过期与不存在返回同一个结果（不给探测口）。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 默认配对令牌有效期：2 分钟。够从容扫码，又短到截图基本没用。 */
const DEFAULT_TOKEN_TTL_MS = 120_000

/** 令牌随机字节数（base64url 后约 43 字符）。 */
const TOKEN_BYTES = 32

/** base64url 编码，与 dsh 内部风格一致（无填充）。 */
function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** 定长比较，避免用长度或提前返回泄露令牌信息。 */
function tokenMatches(actual, expected) {
  const a = Buffer.from(String(actual), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** 一次配对会话（同一时刻最多一个）。 */
export class PairingService {
  /** @param {{ tokenTtlMs?: number }} [options] - 可调项。 */
  constructor(options = {}) {
    const ttl = Number(options.tokenTtlMs)
    this.tokenTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS
    /** @type {{ id: string, issuedAt: number, expiresAt: number } | undefined} */
    this.token = undefined
    /** 成功使用过配对令牌的设备数（诊断用）。 */
    this.acceptedCount = 0
  }

  /**
   * 签发一个新令牌，替换掉旧的。
   * 刷新二维码＝上一张立刻失效，这正是"重新生成"该有的语义。
   * @returns {{ id: string, issuedAt: number, expiresAt: number }} 新令牌。
   */
  issue() {
    const issuedAt = Date.now()
    const token = {
      id: base64url(randomBytes(TOKEN_BYTES)),
      issuedAt,
      expiresAt: issuedAt + this.tokenTtlMs,
    }
    this.token = token
    return token
  }

  /**
   * 当前仍有效的令牌；过期了就顺手清掉。
   * @returns {{ id: string, issuedAt: number, expiresAt: number, remainingMs: number } | undefined}
   */
  current() {
    const token = this.token
    if (token === undefined) return undefined
    const now = Date.now()
    if (token.expiresAt <= now) {
      this.token = undefined
      return undefined
    }
    return { ...token, remainingMs: token.expiresAt - now }
  }

  /** 撤销当前令牌（不影响已进入的设备）。 */
  clear() {
    this.token = undefined
  }

  /**
   * 校验一个配对令牌。过期与不存在返回同样的 false，不给探测口。
   * @param {unknown} id - 请求里的令牌。
   * @returns {boolean} 是否有效。
   */
  accept(id) {
    const current = this.current()
    if (current === undefined) return false
    if (typeof id !== 'string' || id === '') return false
    if (!tokenMatches(id, current.id)) return false
    this.acceptedCount += 1
    return true
  }
}

export default PairingService
