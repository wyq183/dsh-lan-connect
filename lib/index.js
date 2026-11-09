/**
 * dsh-lan-connect — 局域网连接管理插件（host 半侧）
 * v0.2.0 · 适配 DeepSeek Harness 0.1.7 桌面端（DSH Desktop）
 *
 * 解决什么：手机/平板/另一台电脑连不上同一台 dsh。原因有两层——
 *   ① dsh 的浏览器凭据是**进程级随机 launch token**，只在启动日志里出现一次、重启就换；
 *   ② 桌面端把 webServer 固定在回环（127.0.0.1），局域网根本到不了它。
 *
 * 本插件提供两层：
 *
 *  1. **访问门禁**（lib/gateway.js）——在局域网侧另开一个口（默认 3099，绑 0.0.0.0），
 *     进来先登录，过了才反代到 127.0.0.1 上的 dsh。会话默认 7 天到期，到期必须重新输入。
 *     手机的浏览器自始至终拿不到 dsh 的进程令牌——门禁在**服务端**用
 *     `connection.authenticatedUrl()` 换到 authority-bound cookie，自己持有。
 *
 *  2. **连接管理面**（/ext/lan-connect/）——列出可用地址、短时配对二维码、
 *     在线设备、换锁、门禁会话管理。挂在 dsh 本体上，本机浏览器直接用。
 *
 * ── 桌面端适配要点（0.2.0 相对 0.1.0 的改动）───────────────────────────────
 *
 * ⚠ **删掉了「一键让 dsh 本体对外监听」的能力**（原 lib/lan-switch.js）。
 *   它靠改写 profile 的 cordis.patch.yml，把 webserver.host 从 127.0.0.1 切成 0.0.0.0。
 *   桌面端不行，两个理由：
 *     · 桌面端**刻意**只绑回环——那是它的安全设计，不该被插件翻掉；
 *     · 一旦本体真的对外，局域网里任何人直连 `<本机IP>:<dshPort>` 就能**绕过门禁**，
 *       门禁就成了摆设。
 *   所以 v0.2.0 只保留门禁口，本体永远回环。插件会**检测并大声警告**（不静默改配置）。
 *
 * 其余部分（门禁、网关、反向代理、设备表、配对、二维码、管理页）沿用 0.1.0 的实现，
 * 因为 `authenticatedUrl` / `webServer.register` / `connection` 在 0.1.7 上签名未变。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeviceTracker } from './devices.js'
import { PairingService } from './pairing.js'
import { AccessGate } from './gate.js'
import { GateServer } from './gateway.js'
import { InnerAuth } from './proxy.js'
import { createLanConnectHandler, ROUTE_PATH } from './http.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'lan-connect'

/** 只要 webServer 就能挂载；connection 在内部等。 */
export const inject = ['webServer']

/** 默认门禁对外端口。 */
const DEFAULT_GATE_PORT = 3099

/** dsh home 目录：优先环境变量，其次 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 webServer 的上下文。
 * @param {object} [config] - 插件配置。
 * @param {number} [config.gatePort] - 门禁对外端口，默认 3099。
 * @param {boolean} [config.gateEnabled] - 是否启动门禁，默认 true。
 * @param {string} [config.dataDir] - 数据目录，默认 <DSH_HOME>/lan-connect。
 */
export function apply(ctx, config = {}) {
  const home = dshHome()
  // 数据目录刻意**不叫** dsh-lan-connect：插件源码通常就装在 ~/.dsh/dsh-lan-connect，
  // 两者同名的话 devices.json / access.json 会直接落进源码目录里（实测撞过一次）。
  // 保持与 0.1.0 同一路径，这样已配对的设备与门禁密码可以直接续上。
  const dataDir = (typeof config.dataDir === 'string' && config.dataDir !== '')
    ? config.dataDir
    : join(home, 'lan-connect')

  const devicesFile = config.devicesFile === false
    ? undefined
    : (typeof config.devicesFile === 'string' && config.devicesFile !== ''
        ? config.devicesFile
        : join(dataDir, 'devices.json'))

  const tracker = new DeviceTracker({ ttlMs: config.deviceTtlMs, dataFile: devicesFile })
  const pairing = new PairingService({ tokenTtlMs: config.pairingTtlMs })

  const gateEnabled = config.gateEnabled !== false
  const gatePort = Number.isFinite(Number(config.gatePort)) && Number(config.gatePort) > 0
    ? Number(config.gatePort)
    : DEFAULT_GATE_PORT
  const accessFile = config.accessFile === false
    ? undefined
    : (typeof config.accessFile === 'string' && config.accessFile !== ''
        ? config.accessFile
        : join(dataDir, 'access.json'))

  const gate = new AccessGate({
    dataFile: accessFile,
    sessionTtlMs: config.sessionTtlMs,
  })

  /** @type {GateServer | undefined} */
  let gateServer
  /** 门禁状态快照，管理页要读。 */
  let gateState = { enabled: gateEnabled, port: gatePort, running: false, error: undefined }

  ctx.inject(['connection'], (connectionCtx) => {
    const webServer = connectionCtx.webServer
    const dshPort = webServer.port
    const dshHost = webServer.host

    // ── 安全前提：本体必须只在回环上 ──────────────────────────────────────
    // 桌面端天然满足；若不满足（例如有人手改了配置），门禁是可以被绕过的——
    // 这时必须警告，而不是偷偷去改配置。
    if (dshHost !== '127.0.0.1' && dshHost !== 'localhost' && dshHost !== '::1') {
      connectionCtx.logger.warn(
        `lan-connect: ⚠ dsh 本体绑在 ${String(dshHost)}（不是回环）。`
        + `局域网内可绕过门禁直连 http://<本机IP>:${String(dshPort)}/ 。`
        + '桌面端应保持回环绑定；请检查 webserver 配置。',
      )
    } else {
      connectionCtx.logger.info(
        `lan-connect: dsh 本体绑在 ${String(dshHost)}:${String(dshPort)}（回环，门禁前提成立）`,
      )
    }

    // 内部凭据：拿 dsh 的一次性登录链接去兑换一个回环 authority 的 cookie。
    // authority-bound 是关键——这个 cookie 换到别的 authority 就不认账，
    // 所以它只能由门禁在服务端持有，绝不能外泄给手机的浏览器。
    const inner = new InnerAuth(
      () => connectionCtx.connection.authenticatedUrl(`http://127.0.0.1:${String(dshPort)}`),
    )

    // ── 启动门禁服务器 ────────────────────────────────────────────────────
    /** 按当前配置造一个门禁实例（可重复调用，支持停掉后再起）。 */
    const makeGateServer = () => new GateServer({
      port: gatePort,
      dshPort,
      gate,
      // 配对令牌与门禁共享同一个实例：管理页签发的二维码，
      // 由门禁口的 /__gate/pair/<token> 直接认账。
      pairing,
      makeInner: () => inner,
      logger: connectionCtx.logger,
    })

    /** 启停门禁口（管理页的开关走这里，运行期立即生效）。 */
    const gateControl = {
      state: () => ({
        available: true,
        enabled: gateState.enabled,
        running: gateState.running,
        port: gateState.port,
        error: gateState.error,
        dshPort,
        dshHost,
      }),
      start: async () => {
        // 幂等：已经在跑就直接返回。否则会再 createServer 绑一次同一个端口 → EADDRINUSE。
        if (gateState.running) return
        if (gateServer === undefined) gateServer = makeGateServer()
        await gateServer.start()
        gateState = { ...gateState, enabled: true, running: true, error: undefined }
        connectionCtx.logger.info(
          `lan-connect: 门禁已启用 → 局域网用 http://<本机IP>:${String(gatePort)}/ 打开（需登录）`,
        )
      },
      stop: async () => {
        await gateServer?.stop()
        gateState = { ...gateState, enabled: false, running: false }
        connectionCtx.logger.info('lan-connect: 门禁已停用，局域网入口关闭（管理面仍在本机可用）')
      },
    }

    if (gateEnabled) {
      connectionCtx.effect(() => {
        let started = false
        void gateControl.start().then(() => {
          started = true
        }).catch((error) => {
          gateState = { ...gateState, running: false, error: String(error?.message ?? error) }
          connectionCtx.logger.warn(
            `lan-connect: 门禁端口 ${String(gatePort)} 启动失败（${String(error?.message ?? error)}），`
            + '连接管理面不受影响；换个端口可改 gatePort。',
          )
        })
        return async () => {
          if (!started) return
          await gateServer?.stop()
        }
      }, 'lan-connect: access gate')
    }

    // ── 连接管理路由（挂在 dsh 本体上）────────────────────────────────────
    const handler = createLanConnectHandler({
      ctx: connectionCtx,
      connection: connectionCtx.connection,
      tracker,
      pairing,
      gate,
      gateState: () => gateState,
      dshPort,
      gateControl,
    })
    connectionCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
      'lan-connect: /ext/lan-connect routes',
    )

    connectionCtx.logger.info(
      `lan-connect: 管理页 ${ROUTE_PATH}/`
      + (devicesFile === undefined ? '（设备表不落盘）' : ''),
    )
  })
}
