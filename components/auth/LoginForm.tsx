'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppDispatch } from '@/store/hooks'
import { setCredentials } from '@/store/slices/authSlice'

export default function LoginForm() {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [loading, setLocalLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    setLocalLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      })
      const text = await res.text()
      setLocalLoading(false)

      let data: { ok?: boolean; value?: unknown; error?: string }
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        setLocalError(res.ok ? '响应格式错误' : `请求失败 (${res.status})，请检查数据库是否已启动`)
        return
      }

      if (data.ok) {
        dispatch(setCredentials(data.value))
        router.push('/dashboard')
      } else {
        setLocalError(data.error ?? '登录失败')
      }
    } catch (err) {
      setLocalLoading(false)
      setLocalError(err instanceof Error ? err.message : '网络错误，请检查服务是否运行')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {localError && (
        <div className="bg-red-50 text-red-700 p-3 rounded text-sm">{localError}</div>
      )}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">用户名或邮箱</label>
        <input
          type="text"
          required
          value={login}
          onChange={e => setLogin(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
        <input
          type="password"
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
      >
        {loading ? '登录中...' : '登录'}
      </button>
    </form>
  )
}
