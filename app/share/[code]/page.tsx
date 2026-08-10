'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAppDispatch } from '@/store/hooks'
import { setCredentials } from '@/store/slices/authSlice'

export default function SharePage() {
  const { code } = useParams<{ code: string }>()
  const router = useRouter()
  const dispatch = useAppDispatch()
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/share-links/${encodeURIComponent(code)}`)
      .then(async response => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (!response.ok || !data.ok) throw new Error(data.error ?? '分享链接无效')
        dispatch(setCredentials(data.value))
        router.replace(`/projects/${data.value.projectId}`)
      })
      .catch(err => setError(err instanceof Error ? err.message : '分享链接无效'))
  }, [code, dispatch, router])

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <><h1 className="text-lg font-semibold text-red-600">无法打开分享链接</h1><p className="mt-2 text-sm text-gray-500">{error}</p></>
        ) : (
          <><h1 className="text-lg font-semibold text-gray-800">正在打开项目…</h1><p className="mt-2 text-sm text-gray-500">分享链接有效期为一小时</p></>
        )}
      </div>
    </main>
  )
}
