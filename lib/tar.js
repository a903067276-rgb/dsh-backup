/**
 * dsh-backup — 零依赖 tar+gzip 打包器（纯 node API，不依赖系统 tar / shell）
 *
 * 为什么不用 shell 跑 tar：DSH 的 shell 服务把每个命令包进会话沙箱
 * （dsh-bash-sandbox），备份目录在会话工作区外时 tar 无法创建输出文件。
 * 插件 node 层（本文件）跑在 dsh 进程内，文件访问不受 shell 沙箱限制。
 *
 * 格式：POSIX ustar（name ≤100 时；超长名尝试拆 prefix，拆不开跳过该文件）。
 * 目录 typeflag '5'、普通文件 '0'、符号链接 '2'（存 linkname，不跟随）。
 * 流式读写：大文件不整体进内存；尾部 1024 零字节 + gzip 压缩。
 */
import { createReadStream, createWriteStream, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { PassThrough } from 'node:stream'

const BLOCK = 512

/** 八进制字段：n 转 len-1 位八进制 + 结尾 NUL（tar 字段规范）。 */
function octField(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0'
}

/**
 * 构造 512 字节 ustar 头。
 * entry: { name, size, mtimeMs, type: '0'|'5'|'2', linkname? }
 * 返回 { header, name, prefix }——name 超长且拆不开时返回 null。
 */
function tarHeader(entry) {
  const nameBuf = Buffer.from(entry.name, 'utf8')
  let name = entry.name
  let prefix = ''
  if (nameBuf.length > 100) {
    // 拆 prefix：前缀（除最后一段）≤155 且最后一段 ≤100
    const idx = entry.name.lastIndexOf('/')
    if (idx <= 0 || idx > 155 || entry.name.length - idx - 1 > 100) return null
    prefix = entry.name.slice(0, idx)
    name = entry.name.slice(idx + 1)
  }
  const buf = Buffer.alloc(BLOCK)
  buf.write(name.slice(0, 100), 0, 'utf8')
  buf.write('0000644\0', 100, 8) // mode 0644
  buf.write('0000000\0', 108, 8) // uid
  buf.write('0000000\0', 116, 8) // gid
  buf.write(octField(entry.size, 12), 124, 12)
  buf.write(octField(Math.max(0, Math.floor(entry.mtimeMs / 1000)), 12), 136, 12)
  buf.write('        ', 148, 8) // chksum 占位（空格）
  buf.write(entry.type, 156, 1)
  if (entry.type === '2') buf.write(String(entry.linkname || '').slice(0, 100), 157, 'utf8')
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  if (prefix !== '') buf.write(prefix.slice(0, 155), 345, 'utf8')
  // 校验和：全部字节求和（chksum 字段按空格算）
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return { header: buf, name, prefix }
}

/**
 * 生成 .tgz：把 sources（[{root, base}]，archive 路径 = base/相对路径）打包压缩到 outPath。
 * excludes：archive 路径前缀数组（命中即跳过该条目及其子树），如 ['profiles/web/node_modules']。
 * 单文件读失败只告警跳过，不中断整体备份。
 */
export async function createTgz(outPath, sources, excludes) {
  const gzip = createGzip()
  const out = createWriteStream(outPath)
  const tar = new PassThrough()
  const done = pipeline(tar, gzip, out) // 异常会 reject done
  const warnings = []

  const excluded = (arcPath) => {
    for (const ex of excludes) {
      if (arcPath === ex || arcPath.startsWith(ex + '/')) return true
    }
    return false
  }

  async function writeEntry(entry, filePath) {
    const built = tarHeader(entry)
    if (built === null) {
      warnings.push('文件名过长已跳过：' + entry.name)
      return
    }
    tar.write(built.header)
    if (entry.type === '0') {
      // 流式写文件内容（512 对齐）
      let written = 0
      await new Promise((resolve, reject) => {
        const rs = createReadStream(filePath)
        rs.on('data', (chunk) => {
          written += chunk.length
          tar.write(chunk)
        })
        rs.on('error', reject)
        rs.on('end', resolve)
      })
      const pad = (BLOCK - (written % BLOCK)) % BLOCK
      if (pad > 0) tar.write(Buffer.alloc(pad))
    }
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
      } catch (error) {
        warnings.push('条目不可读已跳过：' + childArc)
        continue
      }
      if (st.isSymbolicLink()) {
        let link
        try { link = readlinkSync(childAbs) } catch { continue }
        try {
          await writeEntry({ name: childArc, size: 0, mtimeMs: st.mtimeMs, type: '2', linkname: link }, childAbs)
        } catch (error) { warnings.push('写入失败已跳过：' + childArc) }
      } else if (st.isDirectory()) {
        try {
          await writeEntry({ name: childArc + '/', size: 0, mtimeMs: st.mtimeMs, type: '5' }, childAbs)
        } catch (error) { warnings.push('写入失败已跳过：' + childArc); continue }
        await walkDir(childAbs, childArc)
      } else if (st.isFile()) {
        try {
          await writeEntry({ name: childArc, size: st.size, mtimeMs: st.mtimeMs, type: '0' }, childAbs)
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
        await writeEntry({ name: src.base + '/', size: 0, mtimeMs: st.mtimeMs, type: '5' }, abs)
        await walkDir(abs, src.base)
      } else if (st.isFile()) {
        await writeEntry({ name: src.base, size: st.size, mtimeMs: st.mtimeMs, type: '0' }, abs)
      }
    }
    tar.end(Buffer.alloc(BLOCK * 2)) // 尾部 1024 零字节（tar 结束标记）
    await done
  } catch (error) {
    // 写失败：尝试清理半成品
    try { out.destroy(); tar.destroy() } catch { /* ignore */ }
    throw error
  }
  return warnings
}
