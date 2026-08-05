/** @type {import('next').NextConfig} */
const nextConfig = {
  // These packages resolve native binaries at runtime (the Copilot CLI binary and
  // libvips). Bundling them breaks that lookup with
  // "Could not find a @github/copilot platform package", so they must stay external.
  serverExternalPackages: ['@github/copilot-sdk', '@github/copilot', 'sharp'],
}

export default nextConfig
