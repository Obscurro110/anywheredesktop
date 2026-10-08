const fs = require('fs')
const path = require('path')

const SKIP = new Set(['electron', 'typescript'])

function align(size) {
  return (size + 3) & ~3
}

function pickleUint(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(value >>> 0, 4)
  return buffer
}

function pickleString(data) {
  const payload = align(4 + data.length)
  const buffer = Buffer.alloc(4 + payload)
  buffer.writeUInt32LE(payload, 0)
  buffer.writeUInt32LE(data.length, 4)
  data.copy(buffer, 8)
  return buffer
}

function readAsar(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(8)
    fs.readSync(fd, prefix, 0, 8, 0)
    const headerSize = prefix.readUInt32LE(4)
    const headerPickle = Buffer.alloc(headerSize)
    fs.readSync(fd, headerPickle, 0, headerSize, 8)
    const stringLength = headerPickle.readUInt32LE(4)
    const header = JSON.parse(headerPickle.subarray(8, 8 + stringLength).toString('utf8'))
    const dataStart = 8 + headerSize
    const data = Buffer.alloc(fs.statSync(file).size - dataStart)
    fs.readSync(fd, data, 0, data.length, dataStart)
    return { header, data }
  } finally {
    fs.closeSync(fd)
  }
}

function walk(node, prefix, output) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, `${prefix}${name}/`, output)
    }
    return
  }
  output.set(prefix.slice(0, -1), node)
}

function readJson(buffer) {
  return JSON.parse(buffer.toString('utf8'))
}

function packagedSource(asarFile, relativePath, entry) {
  if (entry && entry.offset != null) {
    const offset = Number(entry.offset)
    return entryBuffer(asarFile, offset, Number(entry.size))
  }
  const unpacked = `${asarFile}.unpacked`
  const file = path.join(unpacked, ...relativePath.split('/'))
  if (fs.existsSync(file)) return fs.readFileSync(file)
  return null
}

function entryBuffer(asarFile, offset, size) {
  const cached = entryBuffer.cache.get(asarFile)
  return cached.subarray(offset, offset + size)
}

entryBuffer.cache = new Map()

function topLevelPackages(files) {
  const packages = new Map()
  for (const relativePath of files.keys()) {
    const parts = relativePath.split('/')
    if (parts[0] !== 'node_modules' || parts.at(-1) !== 'package.json') continue
    if (parts[1].startsWith('@') && parts.length === 4) packages.set(`${parts[1]}/${parts[2]}`, relativePath)
    else if (!parts[1].startsWith('@') && parts.length === 3) packages.set(parts[1], relativePath)
  }
  return packages
}

function findOnDisk(projectDir, name) {
  const direct = path.join(projectDir, 'node_modules', ...name.split('/'))
  if (fs.existsSync(path.join(direct, 'package.json'))) return fs.realpathSync(direct)
  const store = path.join(projectDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(store)) return null
  const folderPrefix = `${name.replace('/', '+')}@`.toLowerCase()
  for (const entry of fs.readdirSync(store)) {
    if (!entry.toLowerCase().startsWith(folderPrefix)) continue
    const candidate = path.join(store, entry, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
  }
  return null
}

function ensureDirectory(root, name) {
  let current = root
  for (const part of name.split('/')) {
    current.files ??= {}
    current.files[part] ??= { files: {} }
    current = current.files[part]
  }
  current.files ??= {}
  return current.files
}

function collectFiles(directory, prefix, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.bin') continue
    const fullPath = path.join(directory, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectFiles(fullPath, relativePath, output)
    else if (entry.isFile()) output.push([relativePath, fs.readFileSync(fullPath)])
  }
}

async function afterPack(context) {
  const projectDir = context.packager?.projectDir || context.projectDir
  const asarFile = path.join(context.appOutDir, 'resources', 'app.asar')
  if (!projectDir || !fs.existsSync(asarFile)) {
    throw new Error(`无法定位打包结果：${asarFile}`)
  }

  const { header, data } = readAsar(asarFile)
  entryBuffer.cache.set(asarFile, data)
  const entries = new Map()
  walk(header, '', entries)
  const present = topLevelPackages(entries)
  const pending = [...present.keys()]
  const additions = []

  while (pending.length > 0) {
    const name = pending.shift()
    if (SKIP.has(name) || name.startsWith('@types/')) continue
    const relativePath = present.get(name)
    let packageJson
    if (relativePath) {
      const source = packagedSource(asarFile, relativePath, entries.get(relativePath))
      if (!source) throw new Error(`无法读取已打包的 ${name}`)
      packageJson = readJson(source)
    } else {
      const directory = findOnDisk(projectDir, name)
      if (!directory) throw new Error(`生产依赖 ${name} 没有打进安装包，node_modules 里也找不到`)
      packageJson = readJson(fs.readFileSync(path.join(directory, 'package.json')))
      additions.push([name, directory])
    }
    for (const dependency of Object.keys(packageJson.dependencies || {})) {
      if (present.has(dependency) || SKIP.has(dependency) || dependency.startsWith('@types/')) continue
      present.set(dependency, null)
      pending.push(dependency)
    }
  }

  if (additions.length === 0) {
    console.log('[pack] 生产依赖已经完整')
    return
  }

  let extra = Buffer.alloc(0)
  for (const [name, directory] of additions) {
    const folder = ensureDirectory(header.files.node_modules, name)
    const files = []
    collectFiles(directory, '', files)
    for (const [relativePath, content] of files) {
      let target = folder
      const parts = relativePath.split('/')
      for (const part of parts.slice(0, -1)) {
        target[part] ??= { files: {} }
        target = target[part].files
      }
      target[parts.at(-1)] = { size: content.length, offset: String(data.length + extra.length) }
      extra = Buffer.concat([extra, content])
    }
    console.log(`[pack] 补入 ${name}（${files.length} 个文件）`)
  }

  const headerJson = Buffer.from(JSON.stringify(header))
  const headerPickle = pickleString(headerJson)
  const output = Buffer.concat([pickleUint(headerPickle.length), headerPickle, data, extra])
  const temporary = `${asarFile}.ensure-deps`
  fs.writeFileSync(temporary, output)
  fs.renameSync(temporary, asarFile)
  console.log(`[pack] 已补入 ${additions.length} 个漏掉的生产依赖`)
}

module.exports = afterPack
