import fs from 'node:fs/promises'
import path from 'node:path'
import { FileError } from './FileStore.js'

export const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd'])
export const MAX_SHARED_FILES = 100
export const MAX_SHARE_BYTES = 20 * 1024 * 1024

// A folder is a snapshot, not a live filesystem mount. Never follow symlinks
// discovered inside it: they could expose files outside the selected folder.
export async function collectShareFiles (paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw new FileError('INVALID_SELECTION', 'Choose Markdown files or a folder.')
  }
  const files = new Map()
  let bytes = 0
  const add = async (file, label) => {
    const real = await fs.realpath(file)
    if (files.has(real)) return
    const st = await fs.stat(real)
    if (!st.isFile()) throw new FileError('NOT_FILE', 'That is not a regular file.')
    bytes += st.size
    if (files.size >= MAX_SHARED_FILES || bytes > MAX_SHARE_BYTES) {
      throw new FileError('SHARE_LIMIT', 'Share up to 100 files and 20 MB in one session.')
    }
    files.set(real, { path: real, name: label })
  }
  const walk = async (dir, prefix) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const file = path.join(dir, entry.name)
      const label = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(file, label)
      else if (entry.isFile() && MD_EXT.has(path.extname(entry.name).toLowerCase())) await add(file, label)
    }
  }
  for (const selected of paths) {
    const real = await fs.realpath(selected)
    const st = await fs.stat(real)
    if (st.isDirectory()) await walk(real, path.basename(selected))
    else {
      if (!MD_EXT.has(path.extname(selected).toLowerCase())) throw new FileError('NOT_MARKDOWN', 'Choose Markdown files (.md, .markdown, .mdown, .mkd).')
      await add(real, path.basename(selected))
    }
  }
  if (!files.size) throw new FileError('EMPTY_FOLDER', 'No Markdown files found in this selection.')
  // Preserve relative folder names; disambiguate separately selected names without
  // revealing absolute parent directories to guests.
  const names = new Set()
  return [...files.values()].map(file => {
    const original = file.name
    let n = 2
    while (names.has(file.name)) file.name = `${original} (${n++})`
    names.add(file.name)
    return file
  })
}
