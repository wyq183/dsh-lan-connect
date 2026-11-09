/**
 * dsh-lan-connect — 在线设备追踪
 *
 * 按 「IP + User-Agent」 归并成一台设备，记录首次/最后活动时间、请求次数，
 * 以及**是不是扫码配对进来的**（viaPair）。
 *
 * 两点设计说明：
 *   1. 内存里保留 TTL 窗口内的条目用于"在线"判定；配置了持久化文件时，
 *      全部条目会落盘，重启后仍能看到"来过哪些设备"，而不是一片空白。
 *   2. 写盘是防抖 + 原子替换（临时文件 → rename）。读到的永远是完整内容；
 *      即便文件损坏也只是当空表处理——观测数据不是安全边界。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 默认离线判定窗口：90 秒。 */
const DEFAULT_TTL_MS = 90_000

/** 持久化文件最多保留多少台设备（超出按最后活动时间淘汰）。 */
const DEFAULT_MAX_DEVICES = 50

/** 写盘防抖：活动很频繁时不要每个请求都落盘。 */
const SAVE_DEBOUNCE_MS = 2_000

/**
 * 把 Node 给出的远端地址规范化成可读的 IPv4 / IPv6。
 * Node 在双栈监听时会把 IPv4 包成 `::ffff:192.168.1.13`，这里剥掉前缀。
 * @param {unknown} raw - `req.socket.remoteAddress`。
 * @returns {string} 规范化后的地址，拿不到时返回 'unknown'。
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string' || raw === '') return 'unknown'
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length)
  if (raw === '::1') return '127.0.0.1'
  return raw
}

/** 把 UA 里最能说明"这是什么设备"的片段抽出来，列表里更好认。 */
export function describeUserAgent(ua) {
  if (typeof ua !== 'string' || ua === '') return '未知客户端'
  const tests = [
    [/iPhone/i, 'iPhone'],
    [/iPad/i, 'iPad'],
    [/Android/i, 'Android'],
    [/Windows/i, 'Windows'],
    [/Macintosh|Mac OS X/i, 'macOS'],
    [/Linux/i, 'Linux'],
  ]
  const hits = tests.filter(([re]) => re.test(ua)).map(([, label]) => label)
  const browser = [
    [/Edg\//i, 'Edge'],
    [/OPR\/|Opera/i, 'Opera'],
    [/Chrome\//i, 'Chrome'],
    [/Firefox\//i, 'Firefox'],
    [/Safari\//i, 'Safari'],
  ].find(([re]) => re.test(ua))
  const parts = [...hits, browser === undefined ? undefined : browser[1]].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '未知客户端'
}

/** 一台被观测到的设备。 */
export class DeviceTracker {
  /** @param {{ ttlMs?: number, dataFile?: string, maxDevices?: number }} [options] - 可调项。 */
  constructor(options = {}) {
    const ttl = Number(options.ttlMs)
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS
    const max = Number(options.maxDevices)
    this.maxDevices = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_DEVICES
    /** @type {string | undefined} */
    this.dataFile = typeof options.dataFile === 'string' && options.dataFile !== '' ? options.dataFile : undefined
    /** @type {Map<string, object>} */
    this.entries = new Map()
    this.saveTimer = undefined
    this.dirty = false
    this.load()
  }

  /** 从磁盘恢复设备表；文件缺失或损坏都当空表处理。 */
  load() {
    if (this.dataFile === undefined || !existsSync(this.dataFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, 'utf8'))
      const devices = parsed?.devices
      if (devices === null || typeof devices !== 'object') return
      for (const [key, value] of Object.entries(devices)) {
        if (value === null || typeof value !== 'object') continue
        this.entries.set(key, {
          key,
          ip: typeof value.ip === 'string' ? value.ip : 'unknown',
          ua: typeof value.ua === 'string' ? value.ua : '',
          label: typeof value.label === 'string' ? value.label : '未知客户端',
          firstSeen: Number(value.firstSeen) || 0,
          lastSeen: Number(value.lastSeen) || 0,
          hits: Number(value.hits) || 0,
          viaPair: value.viaPair === true,
          lastPath: typeof value.lastPath === 'string' ? value.lastPath : '/',
        })
      }
      this.clampToMax()
    } catch {
      this.entries.clear()
    }
  }

  /** 按最后活动时间淘汰超额条目。 */
  clampToMax() {
    if (this.entries.size <= this.maxDevices) return
    const sorted = [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen)
    this.entries = new Map(sorted.slice(0, this.maxDevices).map(item => [item.key, item]))
  }

  /** 标记需要写盘；用防抖合并短时间内的多次活动。 */
  scheduleSave() {
    if (this.dataFile === undefined) return
    this.dirty = true
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, SAVE_DEBOUNCE_MS)
    // 只在退出前才落盘的定时器不该拖住进程退出
    this.saveTimer.unref?.()
  }

  /** 原子写盘：先写临时文件再 rename。 */
  save() {
    if (this.dataFile === undefined || this.dirty === false) return
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      const payload = JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        devices: Object.fromEntries(this.entries),
      }, null, 2)
      const temp = `${this.dataFile}.tmp`
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, this.dataFile)
      this.dirty = false
    } catch {
      // 落盘失败不影响在线功能，下次活动再试
    }
  }

  /**
   * 记录一次设备活动；同一个 IP+UA 累加而不是新建条目。
   * @param {import('node:http').IncomingMessage} req - 原始请求。
   * @param {{ path?: string, viaPair?: boolean }} [extra] - 额外信息。
   * @returns {object} 更新后的设备条目。
   */
  touch(req, extra = {}) {
    const ip = normalizeIp(req.socket?.remoteAddress)
    const ua = String(req.headers?.['user-agent'] ?? '')
    const key = `${ip}|${ua}`
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      existing.lastSeen = now
      existing.hits += 1
      if (typeof extra.path === 'string' && extra.path !== '') existing.lastPath = extra.path
      if (extra.viaPair === true) existing.viaPair = true
      this.scheduleSave()
      return existing
    }
    const entry = {
      key,
      ip,
      ua,
      label: describeUserAgent(ua),
      firstSeen: now,
      lastSeen: now,
      hits: 1,
      viaPair: extra.viaPair === true,
      lastPath: typeof extra.path === 'string' && extra.path !== '' ? extra.path : '/',
    }
    this.entries.set(key, entry)
    this.clampToMax()
    this.scheduleSave()
    return entry
  }

  /**
   * 设备列表，最近活动的在前。
   * 配置了持久化时连离线设备一起返回（online 字段区分）；否则只返回在线设备。
   * @returns {Array<object>} 设备列表。
   */
  list() {
    const cutoff = Date.now() - this.ttlMs
    const rows = []
    for (const [key, entry] of this.entries) {
      const online = entry.lastSeen >= cutoff
      // 没有持久化时，过期条目没有保留价值，直接从内存清掉
      if (!online && this.dataFile === undefined) {
        this.entries.delete(key)
        continue
      }
      rows.push({
        key: entry.key,
        ip: entry.ip,
        label: entry.label,
        ua: entry.ua.length > 160 ? `${entry.ua.slice(0, 160)}…` : entry.ua,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        hits: entry.hits,
        viaPair: entry.viaPair === true,
        online,
        lastPath: entry.lastPath,
      })
    }
    return rows.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** 清空全部记录（换锁后调用）。 */
  clear() {
    this.entries.clear()
    this.dirty = true
    this.save()
  }
}
