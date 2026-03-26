import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Output mode for Docker deployment
  output: 'standalone',
  // Allow large static files (Bryntum library)
  experimental: {
    largePageDataBytes: 256 * 1024 * 1024,
  },
  // Empty turbopack config to suppress webpack conflict warning
  turbopack: {},
}

export default nextConfig
