/**
 * dsh-backup — 零依赖 zip 打包器（纯 node API，不依赖系统 zip / shell）
 *
 * 为什么不用 shell 跑 zip：DSH 的 shell 服务把每个命令包进会话沙箱，
 * 备份目录在会话工作区外时无法写入。插件 node 层（本文件）跑在 dsh 进程内，
 * 文件访问不受 shell 沙箱限制。
 *
 * 格式：标准 ZIP（deflate 压缩 + 流式 data descriptor + UTF-8 文件名标记），
 * macOS 归档实用工具 / Windows 资源管理器 / 7-Zip / 命令行 unzip 均可直接解压。
 * 符号链接按 unix 外部属性（S_IFLNK）存储，内容为目标路径：macOS/7-Zip 解压还原为
 * 软链，Windows 资源管理器解出为小文本文件（可接受，软链本就少见）。
 */
import { createReadStream, createWriteStream, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createDeflateRaw } from 'node:zlib'
import { Transform } from 'node:stream'
import { once } from 'node:events'

// ── CRC32（查表，zip 校验用）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf, crc) {
  let c = (crc ^ -1) >>> 0
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF]
  return (c ^ -1) >>> 0
}

/** DOS 时间/日期（zip 头字段）。 */
function dosDateTime(ms) {
  const d = new Date(ms)
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  }
}

/** unix 外部属性（zip central 高 16 位）：文件 0644 / 目录 0755 / 软链 0777。 */
function externalAttrs(type) {
  const mode = type === '5' ? 0x41ED : type === '2' ? 0xA1FF : 0x81A4 // S_IFDIR|0755 / S_IFLNK|0777 / S_IFREG|0644
  return (mode << 16) >>> 0
}

const SIG_LOCAL = 0x04034B50
const SIG_CENTRAL = 0x02014B50
const SIG_EOCD = 0x06054B50
// flag bit3（data descriptor）+ bit11（UTF-8 文件名）
const FLAGS = 0x0808
const METHOD_DEFLATE = 8

/**
 * 生成 .zip：把 sources（[{root, base}]，zip 路径 = base/相对路径）压缩到 outPath。
 * excludes：zip 路径前缀数组（命中即跳过该条目及其子树）。
 * 单文件读失败只告警跳过，不中断整体备份。返回告警列表。
 */
export async function createZip(outPath, sources, excludes) {
  const out = createWriteStream(outPath)
  const central = [] // { name, crc, csize, usize, time, date, external }
  const warnings = []
  let offset = 0 // 当前写位置（local header 偏移）

  const excluded = (arcPath) => {
    for (const ex of excludes) {
      if (arcPath === ex || arcPath.startsWith(ex + '/')) return true
    }
    return false
  }

  /** 节流写：out 缓冲区满时等 drain。 */
  async function write(buf) {
    if (!out.write(buf)) await once(out, 'drain')
  }

  /** 写 local header + 数据 + data descriptor；返回 { crc, csize, usize, method }。 */
  async function addEntry(entry, filePath) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const dt = dosDateTime(entry.mtimeMs)
    // 压缩方式：普通文件 deflate(8)；软链内容极小且是目标路径文本，原样存储(0)
    const method = entry.type === '2' ? 0 : METHOD_DEFLATE
    const header = Buffer.alloc(30)
    header.writeUInt32LE(SIG_LOCAL, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(FLAGS, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(dt.time, 10)
    header.writeUInt16LE(dt.date, 12)
    header.writeUInt32LE(0, 14) // crc（bit3：写 0）
    header.writeUInt32LE(0, 18) // csize
    header.writeUInt32LE(0, 22) // usize
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28) // extra
    await write(header)
    await write(nameBuf)
    const start = offset
    offset += 30 + nameBuf.length

    let crc = 0
    let csize = 0
    let usize = 0
    if (entry.type === '0') {
      // 流式：读 → CRC 累计 → deflate → 写 out
      const rs = createReadStream(filePath)
      const crcT = new Transform({
        transform(chunk, enc, cb) {
          crc = crc32(chunk, crc)
          usize += chunk.length
          cb(null, chunk)
        },
      })
      const def = createDeflateRaw()
      def.on('data', (c) => { csize += c.length })
      const pipe = rs.pipe(crcT).pipe(def)
      try {
        for await (const chunk of pipe) {
          if (!out.write(chunk)) await once(out, 'drain')
        }
      } finally {
        rs.destroy()
      }
      offset += csize
    } else if (entry.type === '2') {
      // 符号链接：内容 = 目标路径（unix 惯例），原样存储
      const link = Buffer.from(String(entry.linkname || ''), 'utf8')
      crc = crc32(link, 0)
      usize = link.length
      csize = link.length
      if (!out.write(link)) await once(out, 'drain')
      offset += link.length
    }
    // data descriptor（带签名 0x08074b50：macOS ditto 要求带签名，unzip/python 两者都接受）
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074B50, 0)
    dd.writeUInt32LE(crc, 4)
    dd.writeUInt32LE(csize, 8)
    dd.writeUInt32LE(usize, 12)
    await write(dd)
    offset += 16

    central.push({ name: entry.name, crc, csize, usize, method, time: dt.time, date: dt.date, external: externalAttrs(entry.type), offset: start })
  }

  async function walkDir(absPath, arcPath) {
    let entries
    try {
      entries = readdirSync(absPath).sort()
    } catch (error) {
      warnings.push('目录不可读已跳过：' + arcPath + '（' + (error instanceof Error ? error.message : String(error)) + '）')
      return
    }
    for (const child of entries) {
      const childAbs = join(absPath, child)
      const childArc = arcPath === '' ? child : arcPath + '/' + child
      if (excluded(childArc)) continue
      let st
      try {
        st = lstatSync(childAbs)
      } catch {
        warnings.push('条目不可读已跳过：' + childArc)
        continue
      }
      if (st.isSymbolicLink()) {
        let link
        try { link = readlinkSync(childAbs) } catch { continue }
        try {
          await addEntry({ name: childArc, mtimeMs: st.mtimeMs, type: '2', linkname: link }, childAbs)
        } catch (error) { warnings.push('写入失败已跳过：' + childArc) }
      } else if (st.isDirectory()) {
        await walkDir(childAbs, childArc) // zip 不写目录条目，解压自动建目录
      } else if (st.isFile()) {
        try {
          await addEntry({ name: childArc, mtimeMs: st.mtimeMs, type: '0' }, childAbs)
        } catch (error) { warnings.push('写入失败已跳过：' + childArc) }
      }
    }
  }

  try {
    for (const src of sources) {
      const abs = join(src.root, src.base)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        warnings.push('源不存在已跳过：' + src.base)
        continue
      }
      if (st.isDirectory()) {
        await walkDir(abs, src.base)
      } else if (st.isFile()) {
        await addEntry({ name: src.base, mtimeMs: st.mtimeMs, type: '0' }, abs)
      }
    }
    // central directory
    const centralStart = offset
    for (const e of central) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const c = Buffer.alloc(46)
      c.writeUInt32LE(SIG_CENTRAL, 0)
      c.writeUInt16LE(0x031E, 4) // version made by：unix(3) + 2.0(30)
      c.writeUInt16LE(20, 6) // version needed
      c.writeUInt16LE(FLAGS, 8)
      c.writeUInt16LE(e.method, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.csize, 20)
      c.writeUInt32LE(e.usize, 24)
      c.writeUInt16LE(nameBuf.length, 28)
      c.writeUInt16LE(0, 30) // extra
      c.writeUInt16LE(0, 32) // comment
      c.writeUInt16LE(0, 34) // disk
      c.writeUInt16LE(0, 36) // internal attrs
      c.writeUInt32LE(e.external, 38) // external attrs（unix mode）
      c.writeUInt32LE(e.offset, 42)
      await write(c)
      await write(nameBuf)
      offset += 46 + nameBuf.length
    }
    const centralSize = offset - centralStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    await write(eocd)
    out.end()
    await once(out, 'finish')
  } catch (error) {
    try { out.destroy() } catch { /* ignore */ }
    throw error
  }
  return warnings
}
