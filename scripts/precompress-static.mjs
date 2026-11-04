import { readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

// Keep the original files for clients without gzip support. Nginx gzip_static
// serves these complete .gz files with Content-Length instead of streaming gzip.
const root = resolve(process.argv[2] ?? '.next/static')
let count = 0
let sourceBytes = 0
let compressedBytes = 0

async function compressDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await compressDirectory(path)
      continue
    }
    if (!entry.isFile() || !/\.(js|css)$/.test(entry.name)) continue

    const source = await readFile(path)
    const metadata = await stat(path)
    const compressed = gzipSync(source, { level: 9 })
    const temporaryPath = `${path}.gz.${process.pid}.tmp`
    await writeFile(temporaryPath, compressed, { mode: metadata.mode & 0o777 })
    await utimes(temporaryPath, metadata.atime, metadata.mtime)
    await rename(temporaryPath, `${path}.gz`)
    count++
    sourceBytes += source.length
    compressedBytes += compressed.length
  }
}

await compressDirectory(root)
console.log(`Precompressed ${count} static assets: ${sourceBytes} -> ${compressedBytes} bytes`)
