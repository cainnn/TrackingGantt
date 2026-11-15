'use client'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export function useGanttViewport(left: RefObject<HTMLDivElement | null>, right: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 800, width: 1200 })
  const pending = useRef<number | null>(null)
  const measureViewport = useCallback(() => {
    if (pending.current != null) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      if (!left.current || !right.current) return
      const next = { top: left.current.scrollTop, left: right.current.scrollLeft,
        height: Math.max(left.current.clientHeight, right.current.clientHeight), width: right.current.clientWidth }
      setViewport(previous => Object.keys(next).every(key => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next)
    })
  }, [left, right])
  useEffect(() => {
    const observer = new ResizeObserver(measureViewport)
    if (left.current) observer.observe(left.current)
    if (right.current) observer.observe(right.current)
    measureViewport()
    return () => { observer.disconnect(); if (pending.current != null) cancelAnimationFrame(pending.current); pending.current = null }
  }, [left, right, measureViewport])
  return { viewport, measureViewport }
}
