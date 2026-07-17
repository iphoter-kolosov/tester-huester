/** @type {import('next').NextConfig} */
const nextConfig = {
  // @th/db ships TS source — let Next compile it. Its native/wasm deps must NOT be bundled.
  transpilePackages: ['@th/db'],
  serverExternalPackages: ['better-sqlite3'],
}
export default nextConfig
