/**
 * Uploaded file storage.
 *
 * The original PDF is kept forever: it is the evidence behind every costed
 * month, and a parser regression a year from now has to be auditable against
 * the document that produced it. The database stores the path, never the bytes.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

export const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex')

const uploadRoot = () => process.env.UPLOAD_DIR ?? './data/uploads'

/**
 * Stored by content hash, sharded two levels deep so a directory never fills
 * with thousands of entries. The same bill uploaded twice lands on the same
 * path, which is what makes the unique constraint on sha256 a real guard
 * rather than a race.
 */
export function storagePathFor(hash: string, filename: string): string {
  const ext = extname(filename).toLowerCase() || '.bin'
  return join(hash.slice(0, 2), hash.slice(2, 4), `${hash}${ext}`)
}

export async function storeFile(
  buf: Buffer,
  filename: string
): Promise<{ hash: string; storagePath: string; byteSize: number }> {
  const hash = sha256(buf)
  const rel = storagePathFor(hash, filename)
  const abs = join(uploadRoot(), rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, buf)
  return { hash, storagePath: rel, byteSize: buf.byteLength }
}

export const readStoredFile = (storagePath: string): Promise<Buffer> =>
  readFile(join(uploadRoot(), storagePath))

/** Guards the upload endpoint before anything touches disk or the API. */
export function checkUpload(
  filename: string,
  size: number,
  maxBytes = 32 * 1024 * 1024
): string | null {
  if (!/\.pdf$/i.test(filename)) return 'Only PDF bills can be uploaded.'
  if (size === 0) return 'That file is empty.'
  // The API rejects a document over 32 MB, so refuse it here with a sentence
  // that says why rather than letting it fail deep in the parse.
  if (size > maxBytes) {
    return `That file is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is ` +
      `${maxBytes / 1024 / 1024} MB.`
  }
  return null
}
