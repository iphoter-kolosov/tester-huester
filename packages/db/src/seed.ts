import { repo } from './db'

// A fixed demo project + ingest key so the extension has something to point at out of the box.
const DEMO_KEY = 'th_demo_key_0001'
const p = repo.ensureProject('Demo', DEMO_KEY)
console.log(`seed: project "Demo" (id=${p.id}, ingestKey=${DEMO_KEY})`)
process.exit(0)
