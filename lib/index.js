/**
 * dsh-backup — 自动备份插件（host 半）
 *
 * 定时 + 手动备份 DSH 重要数据到备份目录：
 *   默认备份 ~/.dsh/sessions（会话记录）、~/.dsh/profiles（配置，排除 node_modules）、
 *   ~/.dsh/AGENTS.md（全局约定），外加配置里的自定义目录列表。
 *   打包为 .zip（纯 node 实现 zip，见 lib/zip.js——不用 shell 跑 zip，
 *   避免会话沙箱拦截工作区外的写入），保留最近 keepCount 份，旧的自动删除（轮转）。
 *
 * 只备份、不恢复：恢复 = 用户手动解压覆盖（文档写明步骤），插件不做危险的一键恢复。
 *
 * HTTP API（设置页调用）：
 *   GET  /api/dsh-backup/status  当前生效配置 + 备份列表 + 上次/下次备份时间
 *   POST /api/dsh-backup/backup  立即备份
 *   POST /api/dsh-backup/delete  删除某份备份 { name }
 *   POST /api/dsh-backup/config  保存配置（写回 cordis.patch.yml，重启生效）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createZip } from './zip.js'

export const name = 'dsh-backup'
// 硬依赖：webServer（HTTP 路由）/ timer（定时）。备份用纯 node API（lib/zip.js），不依赖 shell：
// DSH 的 shell 服务会把命令包进会话沙箱，备份目录在会话工作区外时无法写入。
export const inject = ['webServer', 'timer']

const DEFAULT_BACKUP_DIR = join(homedir(), 'Documents', 'DSH', 'backup')
const BACKUP_PREFIX = 'dsh-backup-'
const MIN_INTERVAL_MS = 10 * 60 * 1000 // 定时最小间隔 10 分钟（防误配成疯狂备份）

/** 当前 profile 名：--profile argv 优先（dsh --profile test 时插件进程 env 里没有 DSH_PROFILE），
 *  DSH_PROFILE env 次之，默认 web。 */
function detectProfile() {
  const argv = process.argv || []
  const i = argv.indexOf('--profile')
  if (i >= 0 && argv[i + 1] !== undefined && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') return argv[i + 1]
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith('--profile='))
  if (eq !== undefined) return eq.slice('--profile='.length)
  if (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '') return process.env.DSH_PROFILE
  return 'web'
}

export function apply(ctx, config) {
  const webServer = ctx.webServer
  const timer = ctx.timer
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 当前 profile 名：--profile argv 优先（副本 test 验证时写回 test 的 patch，不误写正本 web）
  const profileName = detectProfile()
  const PATCH_PATH = join(dshHome, 'profiles', profileName, 'cordis.patch.yml')

  // ── 生效配置（cordis config；字段缺失回退默认值，改配置需重启）──
  const state = {
    backupDir: typeof config?.backupDir === 'string' && config.backupDir !== '' ? config.backupDir : DEFAULT_BACKUP_DIR,
    customDirs: Array.isArray(config?.customDirs) ? config.customDirs.filter((s) => typeof s === 'string' && s !== '') : [],
    intervalHours: typeof config?.intervalHours === 'number' && config.intervalHours > 0 ? config.intervalHours : 6,
    keepCount: typeof config?.keepCount === 'number' && config.keepCount > 0 ? config.keepCount : 10,
    enabled: config?.enabled !== false,
  }

  // ── 运行时状态（不落盘）──
  const runtime = { lastBackupAt: null, lastBackupName: null, lastError: null, nextAt: null, inFlight: false }

  /** 备份文件名时间戳：YYYYMMDD-HHmmss（字典序 = 时间序，轮转/排序直接用） */
  function stamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  }

  /** 备份源清单 [{root, base}]：存在的才打包。profiles 排除 node_modules（安装包重装即可）。 */
  function sourcePairs() {
    const pairs = []
    for (const child of ['sessions', 'profiles', 'AGENTS.md']) {
      if (existsSync(join(dshHome, child))) pairs.push({ root: dshHome, base: child })
    }
    for (const dir of state.customDirs) {
      if (typeof dir === 'string' && dir !== '' && existsSync(dir)) pairs.push({ root: dirname(dir), base: basename(dir) })
    }
    return pairs
  }

  /** profiles 下 node_modules 排除前缀（zip 打包器按路径前缀匹配）：顶层 + 各 profile 内。 */
  function excludePatterns() {
    const patterns = ['profiles/node_modules'] // profiles 顶层安装包目录（重装即可，不备份）
    try {
      const profilesDir = join(dshHome, 'profiles')
      for (const p of readdirSync(profilesDir)) {
        patterns.push('profiles/' + p + '/node_modules')
      }
    } catch { /* profiles 目录不可读则只给顶层模式 */ }
    return patterns
  }

  /** 备份目录下的备份列表（新的在前），目录不存在/不可读返回 []。 */
  function listBackups() {
    try {
      return readdirSync(state.backupDir)
        .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.zip'))
        .sort()
        .map((n) => {
          const st = statSync(join(state.backupDir, n))
          return { name: n, size: st.size, mtime: st.mtimeMs }
        })
        .reverse()
    } catch {
      return []
    }
  }

  /** 轮转：只保留最近 keepCount 份，旧的删除。 */
  function pruneBackups() {
    let names = []
    try {
      names = readdirSync(state.backupDir).filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith('.zip')).sort()
    } catch {
      return
    }
    while (names.length > state.keepCount) {
      const old = names.shift()
      try { rmSync(join(state.backupDir, old), { force: true }) } catch { /* ignore */ }
    }
  }

  /** 执行一次备份：tar 打包全部源 → 返回结果（并发时拒绝第二次）。 */
  async function runBackup() {
    if (runtime.inFlight) return { ok: false, error: '备份进行中，请稍候' }
    runtime.inFlight = true
    try {
      try {
        mkdirSync(state.backupDir, { recursive: true })
      } catch (error) {
        throw new Error('备份目录不可写：' + state.backupDir)
      }
      const pairs = sourcePairs()
      if (pairs.length === 0) throw new Error('没有可备份的内容（检查自定义目录路径）')
      const out = join(state.backupDir, BACKUP_PREFIX + stamp() + '.zip')
      const warnings = await createZip(out, pairs, excludePatterns())
      if (!existsSync(out)) throw new Error('打包未产出备份文件')
      const size = statSync(out).size
      runtime.lastBackupAt = Date.now()
      runtime.lastBackupName = basename(out)
      runtime.lastError = warnings.length > 0 ? '备份完成（' + warnings.length + ' 项跳过：' + warnings[0] + '）' : null
      pruneBackups()
      return { ok: true, name: basename(out), size }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.lastError = message
      return { ok: false, error: message }
    } finally {
      runtime.inFlight = false
    }
  }

  /** 定时调度：enabled 时按 intervalHours 挂 interval，返回 disposer（卸载时清理）。 */
  function schedule() {
    if (state.enabled && timer !== undefined) {
      const ms = Math.max(MIN_INTERVAL_MS, Math.round(state.intervalHours * 3600000))
      const dispose = timer.interval(() => {
        runBackup().catch(() => { /* 错误已进 runtime.lastError */ })
      }, ms)
      runtime.nextAt = Date.now() + ms
      return dispose
    }
    runtime.nextAt = null
    return () => {}
  }
  ctx.effect(() => schedule(), 'dsh-backup: schedule timer')

  function readPatchText() {
    try { return readFileSync(PATCH_PATH, 'utf8') } catch { return undefined }
  }

  /** 在 patch 里找 dsh-backup 条目块（`- id: backup` 到下一个列首 `- id:` 或结尾）。 */
  function findBackupBlock(text) {
    const lines = text.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^- id:\s*backup\s*$/.test(lines[i])) { start = i; break }
    }
    if (start === -1) return { start: -1, end: -1, block: '' }
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^- id:/.test(lines[i])) { end = i; break }
    }
    return { start, end, block: lines.slice(start, end).join('\n') }
  }

  /** 配置的 YAML 行（缩进由调用方给，值 JSON.stringify 转义为合法 YAML 标量）。 */
  function configLines(next, indent) {
    return [
      indent + 'backupDir: ' + JSON.stringify(next.backupDir),
      indent + 'customDirs: ' + JSON.stringify(next.customDirs),
      indent + 'intervalHours: ' + next.intervalHours,
      indent + 'keepCount: ' + next.keepCount,
      indent + 'enabled: ' + (next.enabled ? 'true' : 'false'),
    ].join('\n') + '\n'
  }

  /** 写回 patch：有条目则行级替换/补齐 config 键，无条目则追加。零依赖，不引 yaml 库。 */
  function updatePatchConfig(next) {
    let text = readPatchText()
    if (text === undefined) text = '# dsh-backup: 自动备份配置（设置页可改，重启生效）\n'
    const { start, end, block } = findBackupBlock(text)
    const lines = text.split('\n')
    if (start === -1) {
      const trimmed = text.trimEnd()
      const entry = '\n- id: backup\n  name: \'dsh-backup\'\n  config:\n' + configLines(next, '    ')
      if (trimmed === '[]' || trimmed === '') return text.replace(trimmed, '[]\n' + entry)
      return text + entry
    }
    const blockLines = block.split('\n')
    const cfgIdx = blockLines.findIndex((l) => /^\s+config:/.test(l))
    const cfgIndent = cfgIdx >= 0 ? blockLines[cfgIdx].match(/^\s*/)[0] : '  '
    const wanted = configLines(next, cfgIndent + '  ').split('\n').filter((l) => l.trim() !== '')
    if (cfgIdx === -1) {
      const nameIdx = blockLines.findIndex((l) => /^\s+name:/.test(l))
      blockLines.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, cfgIndent + 'config:', ...wanted)
    } else {
      const wantedKeys = new Set(wanted.map((l) => l.match(/^\s*([\w-]+):/)[1]))
      const existingKeys = new Set(
        blockLines
          .filter((l) => /^\s+[\w-]+:/.test(l) && !/^\s+config:/.test(l))
          .map((l) => l.match(/^\s+([\w-]+):/)[1])
      )
      // 已有键：行级替换（保留原行缩进，值整体换掉）
      for (let i = 0; i < blockLines.length; i++) {
        const m = blockLines[i].match(/^(\s+)([\w-]+):/)
        if (m !== null && wantedKeys.has(m[2])) {
          const line = wanted.find((l) => l.trim().startsWith(m[2] + ':'))
          if (line !== undefined) blockLines[i] = m[1] + line.trim()
        }
      }
      // 缺键：按 wanted 顺序插入 config: 行之后
      const missing = wanted.filter((l) => !existingKeys.has(l.match(/^\s*([\w-]+):/)[1]))
      if (missing.length > 0) blockLines.splice(cfgIdx + 1, 0, ...missing)
    }
    return [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join('\n')
  }

  /** 校验并归一化设置页提交的配置；不合法返回 null。 */
  function sanitizeConfig(body) {
    if (typeof body !== 'object' || body === null) return null
    const backupDir = typeof body.backupDir === 'string' ? body.backupDir.trim() : ''
    const isAbs = (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
    if (backupDir === '' || !isAbs(backupDir)) return null
    const intervalHours = Number(body.intervalHours)
    if (!Number.isFinite(intervalHours) || intervalHours < 0.1) return null
    const keepCount = Number(body.keepCount)
    if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 100) return null
    const customDirs = Array.isArray(body.customDirs)
      ? body.customDirs.map((s) => String(s).trim()).filter((s) => s !== '')
      : []
    for (const d of customDirs) {
      if (!isAbs(d)) return null
    }
    return { backupDir, customDirs, intervalHours, keepCount, enabled: body.enabled !== false }
  }

  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    try { return JSON.parse(text || '{}') } catch { return {} }
  }

  function writeJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/dsh-backup',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          const pathname = url.pathname.replace(/\/+$/, '')

          if (pathname === '/api/dsh-backup/status') {
            writeJson(res, 200, {
              ok: true,
              // homeDir：client 用它在显示层把绝对路径缩写为 ~（不暴露用户名）
              homeDir: homedir(),
              config: {
                backupDir: state.backupDir,
                customDirs: state.customDirs,
                intervalHours: state.intervalHours,
                keepCount: state.keepCount,
                enabled: state.enabled,
              },
              backups: listBackups(),
              lastBackupAt: runtime.lastBackupAt,
              lastBackupName: runtime.lastBackupName,
              lastError: runtime.lastError,
              nextAt: runtime.nextAt,
            })
            return
          }

          if (pathname === '/api/dsh-backup/backup' && req.method === 'POST') {
            const result = await runBackup()
            writeJson(res, result.ok ? 200 : 500, { ...result, backups: listBackups() })
            return
          }

          if (pathname === '/api/dsh-backup/delete' && req.method === 'POST') {
            const body = await readBody(req)
            const name = body && typeof body.name === 'string' ? body.name : ''
            // 防目录穿越：只允许删本插件命名规则的文件（dsh-backup-YYYYMMDD-HHmmss.zip）
            if (!/^dsh-backup-\d{8}-\d{6}\.zip$/.test(name)) {
              writeJson(res, 400, { ok: false, error: '非法文件名' })
              return
            }
            try {
              rmSync(join(state.backupDir, name), { force: true })
            } catch (error) {
              writeJson(res, 500, { ok: false, error: '删除失败：' + (error instanceof Error ? error.message : String(error)) })
              return
            }
            writeJson(res, 200, { ok: true, backups: listBackups() })
            return
          }

          if (pathname === '/api/dsh-backup/config' && req.method === 'POST') {
            const body = await readBody(req)
            const next = sanitizeConfig(body)
            if (next === null) {
              writeJson(res, 400, { ok: false, error: '配置不合法：备份目录/自定义目录必须是绝对路径，间隔 ≥ 0.1 小时，保留份数 1~100' })
              return
            }
            try {
              writeFileSync(PATCH_PATH, updatePatchConfig(next))
              writeJson(res, 200, {
                ok: true,
                message: '已保存，重启 dsh web 后生效',
                config: next,
                patchPath: PATCH_PATH,
              })
            } catch (error) {
              writeJson(res, 500, { ok: false, error: '写入配置失败：' + (error instanceof Error ? error.message : String(error)) })
            }
            return
          }

          writeJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-backup: routes')
    console.error('[dsh-backup] host loaded（backupDir=' + state.backupDir + '）')
  }
}
