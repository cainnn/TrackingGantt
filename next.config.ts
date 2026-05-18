import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow large static files (Bryntum library)
  experimental: {
    largePageDataBytes: 256 * 1024 * 1024,
  },
  // 显式开启响应压缩；大项目 GET /api/tasks 返回 ~2MB JSON，gzip 后 ~200KB
  compress: true,
}

export default nextConfig
