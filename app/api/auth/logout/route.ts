import { NextResponse } from 'next/server'
import { success } from '@/lib/result'

export async function POST() {
  const response = NextResponse.json(success({ loggedOut: true }))
  response.cookies.delete('token')
  return response
}
