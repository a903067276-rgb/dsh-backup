// dsh-backup 打包源 / 排除规则离线测试（2026-10-01 新增，v0.4.0）
//
// 覆盖本轮改动：
//   ① 默认源扩充 —— cordis.patch.yml / storages / bin / llm-deepseek / 根层小配置 / attachments
//   ② 噪音与缓存排除 —— *.lock / *.bak-fix / *-shm / *-wal / *.DS_Store / storages/session_projcache*
//   ③ includeAttachments=false 时附件不进包
//   ④ customDirs（自定义目录）照旧生效
//
// 做法（与 dsh-perm-guard / dsh-simple-memory 的离线测试同款）：lib/index.js 会 import 宿主包
// （@deepseek-ai/schemastery），独立跑不起来 → 从源码文本里**切出真函数段**，注入 node:fs/node:path
// 与假 dshHome/state 后求值；再用本仓真的 zip 打包器 createZip 产出压缩包，解开断言条目集合。
// 全程只碰临时目录，不碰真实 ~/.dsh。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createZip } from '../lib/zip.js'

const HOME = join(tmpdir(), 'dsh-backup-test-home')
const OUT = join(tmpdir(), 'dsh-backup-test-out')
const EXTRA = join(tmpdir(), 'dsh-backup-test-extra')

/** 从 lib/index.js 切出 sourcePairs / excludePatterns 及常量，注入依赖后取回真函数。 */
function loadSourceFns(state) {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = src.indexOf('  /** 备份源清单')
  const end = src.indexOf('  /** 备份目录下的备份列表')
  assert.ok(start > 0 && end > start, '源码里应能定位到 sourcePairs 段')
  const slice = src.slice(start, end)
  const factory = new Function(
    'existsSync', 'join', 'dirname', 'basename', 'readdirSync', 'statSync', 'dshHome', 'state',
    slice + '\n  return { sourcePairs, excludePatterns };'
  )
  return factory(nodeFs.existsSync, nodePath.join, nodePath.dirname, nodePath.basename, nodeFs.readdirSync, nodeFs.statSync, HOME, state)
}

function put(rel, bytes = 64) {
  const abs = join(HOME, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, randomBytes(bytes))
}

function setup() {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  rmSync(EXTRA, { recursive: true, force: true })
  // 会话（夹带四种噪音）
  put('sessions/w1/s1/session.v4.jsonl.zstd', 4096)
  put('sessions/w1/s1/session.lock', 8)
  put('sessions/w1/s1/session.v4.jsonl.zstd.bak-fix', 64)
  put('sessions/w1/s1/session-index.sqlite-shm', 8)
  put('sessions/w1/s1/session-index.sqlite-wal', 8)
  put('sessions/w1/.DS_Store', 8)
  // 配置（node_modules 必须排除）
  put('profiles/web/cordis.patch.yml', 64)
  put('profiles/web/node_modules/pkg/index.js', 64)
  put('AGENTS.md', 64)
  // 2026-10-01 新增源
  put('cordis.patch.yml', 64)
  put('storages/schedule.json', 64)
  put('storages/session_projcache/blob.bin', 64)
  put('storages/session_projcache.json', 64)
  put('bin/dsh-retry', 64)
  put('llm-deepseek/files-v3.json', 64)
  put('perm-guard.json', 16)
  // 明确不备份（可重建）
  put('session-index.sqlite', 4096)
  put('cache/big.bin', 4096)
  // 上传附件
  put('attachments/v1/a.png', 64)
  // 自定义目录
  mkdirSync(join(EXTRA, 'memory'), { recursive: true })
  writeFileSync(join(EXTRA, 'memory/note.md'), '# note\n')
}

/** 挂真函数 + 真 zip 打包器跑一次，返回条目名数组 */
async function runPack(includeAttachments) {
  const state = { includeAttachments, customDirs: [join(EXTRA, 'memory')] }
  const { sourcePairs, excludePatterns } = loadSourceFns(state)
  const pairs = sourcePairs()
  const excludes = excludePatterns()
  mkdirSync(OUT, { recursive: true })
  const zipPath = join(OUT, 'test.zip')
  await createZip(zipPath, pairs, excludes)
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '').map((s) => s.replace(/^\.\//, ''))
}

const EXPECTED = [
  'sessions/w1/s1/session.v4.jsonl.zstd',
  'profiles/web/cordis.patch.yml',
  'AGENTS.md',
  'cordis.patch.yml',
  'storages/schedule.json',
  'bin/dsh-retry',
  'llm-deepseek/files-v3.json',
  'perm-guard.json',
  'attachments/v1/a.png',
  'memory/note.md', // 自定义目录
]

const FORBIDDEN = [
  'sessions/w1/s1/session.lock',
  'sessions/w1/s1/session.v4.jsonl.zstd.bak-fix',
  'sessions/w1/s1/session-index.sqlite-shm',
  'sessions/w1/s1/session-index.sqlite-wal',
  'sessions/w1/.DS_Store',
  'profiles/web/node_modules/pkg/index.js',
  'storages/session_projcache/blob.bin',
  'storages/session_projcache.json',
  'session-index.sqlite',
  'cache/big.bin',
]

test('默认源扩充 + 排除规则 + 自定义目录（includeAttachments 开）', async () => {
  setup()
  const names = await runPack(true)
  for (const p of EXPECTED) assert.ok(names.includes(p), '应包含 ' + p + '（实际 ' + names.length + ' 条）')
  for (const p of FORBIDDEN) assert.ok(!names.includes(p), '不应包含 ' + p)
})

test('includeAttachments=false → 附件不进包，其余照旧', async () => {
  setup()
  const names = await runPack(false)
  assert.ok(!names.includes('attachments/v1/a.png'), '关掉开关后附件不应进包')
  assert.ok(names.includes('cordis.patch.yml'), '其它新增源不受影响')
  assert.ok(names.includes('memory/note.md'), '自定义目录不受影响')
  // 根层小文件仍收，但 session-index.sqlite（非小配置文件后缀）仍不收
  assert.ok(names.includes('perm-guard.json'), '根层小配置应仍在')
  assert.ok(!names.includes('session-index.sqlite'), '大文件仍不收')
})
