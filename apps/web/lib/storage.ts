import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Blobs (screenshots, replay JSON) live behind this interface so the rest of the app never cares where bytes
// are. Files are written to a data dir OUTSIDE Next's static tree and served by an app route
// (`/api/asset/<name>`) — that route works for runtime-written files in production, which `public/` does not.
// Swap LocalDiskStorage for an R2/S3 impl later without touching callers.
export interface Storage {
  put(dataUrl: string): Promise<string> // image data URL → served URL
  putJson(value: unknown): Promise<string> // arbitrary JSON blob (e.g. rrweb replay) → served URL
}

// Shared with the /api/asset route so both agree on where bytes live.
export const ASSET_DIR = path.resolve(process.env.UPLOAD_DIR || path.resolve(process.cwd(), '.data', 'uploads'))
export const ASSET_BASE = '/api/asset'

class LocalDiskStorage implements Storage {
  constructor(private dir: string, private base: string) {}

  private async write(name: string, buf: Buffer): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(path.join(this.dir, name), buf)
    return `${this.base}/${name}`
  }

  async put(dataUrl: string): Promise<string> {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(dataUrl)
    if (!m) throw new Error('not an image data URL')
    const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg'
    return this.write(`${crypto.randomUUID()}.${ext}`, Buffer.from(m[2]!, 'base64'))
  }

  async putJson(value: unknown): Promise<string> {
    return this.write(`${crypto.randomUUID()}.json`, Buffer.from(JSON.stringify(value), 'utf8'))
  }
}

export const storage: Storage = new LocalDiskStorage(ASSET_DIR, ASSET_BASE)
