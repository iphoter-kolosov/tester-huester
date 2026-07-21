/** @type {import('next').NextConfig} */
const nextConfig = {
  // @th/db and @th/core ship TS source — let Next compile it. The DB uses Node 24's built-in
  // `node:sqlite`, which is a node: builtin and is always external, so no bundler config is needed.
  transpilePackages: ['@th/db', '@th/core'],
}
export default nextConfig
