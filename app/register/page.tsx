import Link from 'next/link'
import AppLogo from '@/components/AppLogo'
import RegisterForm from '@/components/auth/RegisterForm'

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow p-8 w-full max-w-md">
        <div className="mb-6">
          <AppLogo size="md" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-6">创建账号</h1>
        <RegisterForm />
        <p className="mt-4 text-center text-sm text-gray-600">
          已有账号？{' '}
          <Link href="/login" className="text-blue-600 hover:underline">
            返回登录
          </Link>
        </p>
      </div>
    </div>
  )
}
