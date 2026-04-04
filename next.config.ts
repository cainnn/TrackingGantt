import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow large static files (Bryntum library)
  experimental: {
    largePageDataBytes: 256 * 1024 * 1024,
  },
}

export default nextConfig
