import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Screenshots live behind this interface so the rest of the app never cares where bytes are:
//   - dev  → local disk under public/uploads, served at /uploads
//   - prod → Cloudflare R2 / S3 (added later, same interface)
export interface Storage {
  put(dataUrl: string): Promise<string>
}

class LocalDiskStorage implements Storage {
  constructor(private dir: string, private publicBase: string) {}
  async put(dataUrl: string): Promise<string> {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl)
    if (!m) throw new Error('not an image data URL')
    const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg'
    const buf = Buffer.from(m[2]!, 'base64')
    const name = `${crypto.randomUUID()}.${ext}`
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(path.join(this.dir, name), buf)
    return `${this.publicBase}/${name}`
  }
}

export const storage: Storage = new LocalDiskStorage(
  process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'public', 'uploads'),
  '/uploads',
)
