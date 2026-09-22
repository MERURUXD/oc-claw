import { useEffect, useRef, useState } from 'react'
import type { ChromaKeyOptions, VideoTransparencyMode } from '../lib/videoPet'

export type { ChromaKeyOptions, VideoTransparencyMode }

export interface BufferedVideoProps {
  src?: string
  altSrc?: string
  getAlternateSrc?: (url: string) => string | undefined
  loop?: boolean
  playbackRate?: number
  onPlaying?: () => void
  onEnded?: () => void
  onError?: (error: unknown) => void
  transparency?: VideoTransparencyMode
  chromaKeyOptions?: ChromaKeyOptions
  canvasWidth?: number
  canvasHeight?: number
  transform?: string
  className?: string
  style?: React.CSSProperties
  objectFit?: 'contain' | 'cover' | 'fill' | 'none'
  draggable?: boolean
}

const isWindowsPlatform =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

/**
 * Reusable double-buffered video component.
 *
 * Implements seamless front/back buffer role swapping on animation changes:
 * - The currently visible animation stays on the front buffer.
 * - The new animation loads in the background on the hidden back buffer.
 * - The front and back buffers swap only when the new video emits 'playing'.
 * - Stale video loading from rapid source changes (A -> B -> C) is tracked
 *   via generation identities and discarded cleanly.
 * - Optional Windows canvas chroma-key fallback keys out black backgrounds
 *   when WebView2 drops VP9 alpha.
 */
export function BufferedVideo({
  src,
  altSrc,
  getAlternateSrc,
  loop = true,
  playbackRate = 1,
  onPlaying,
  onEnded,
  onError,
  transparency = 'native',
  chromaKeyOptions,
  canvasWidth,
  canvasHeight,
  transform,
  className,
  style,
  objectFit = 'contain',
  draggable = false,
}: BufferedVideoProps) {
  const videoRefA = useRef<HTMLVideoElement>(null)
  const videoRefB = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Active front buffer (0=A, 1=B)
  const activeBufferRef = useRef<0 | 1>(0)
  const [activeBuffer, setActiveBuffer] = useState<0 | 1>(0)
  const prevSrcRef = useRef<string | undefined>(undefined)
  const generationRef = useRef(0)

  const onPlayingRef = useRef(onPlaying)
  onPlayingRef.current = onPlaying
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const getAlternateSrcRef = useRef(getAlternateSrc)
  getAlternateSrcRef.current = getAlternateSrc
  const altSrcRef = useRef(altSrc)
  altSrcRef.current = altSrc
  const playbackRateRef = useRef(playbackRate)
  playbackRateRef.current = playbackRate

  const effectiveTransparency =
    transparency === 'auto'
      ? isWindowsPlatform
        ? 'windows-chroma-key'
        : 'native'
      : transparency

  const useChromaKey = effectiveTransparency === 'windows-chroma-key'

  // Video swapping and loading lifecycle (strictly depends on src;
  // playbackRate and altSrc are accessed via refs to prevent listener cancellation races)
  useEffect(() => {
    if (!src) {
      prevSrcRef.current = undefined
      return
    }

    const frontIdx = activeBufferRef.current
    const backIdx: 0 | 1 = frontIdx === 0 ? 1 : 0
    const front = frontIdx === 0 ? videoRefA.current : videoRefB.current
    const back = backIdx === 0 ? videoRefA.current : videoRefB.current

    if (!front || !back) {
      prevSrcRef.current = undefined
      return
    }

    if (prevSrcRef.current === src) return

    const isFirstLoad = prevSrcRef.current === undefined
    prevSrcRef.current = src
    const generation = ++generationRef.current

    let cancelled = false
    const listeners: Array<() => void> = []

    const addOnce = (
      el: HTMLVideoElement,
      event: 'playing' | 'error',
      fn: () => void,
    ) => {
      el.addEventListener(event, fn, { once: true })
      listeners.push(() => el.removeEventListener(event, fn))
    }

    const clearListeners = () => {
      for (const off of listeners) off()
      listeners.length = 0
    }

    const finishSwap = (newFront: 0 | 1) => {
      if (cancelled || generationRef.current !== generation) return
      activeBufferRef.current = newFront
      setActiveBuffer(newFront)
      // Only pause the old buffer; do not clear its src synchronously
      // so React has time to apply visibility: hidden without a blank flash.
      const old = newFront === 0 ? videoRefB.current : videoRefA.current
      if (old) {
        old.pause()
      }
      onPlayingRef.current?.()
    }

    const allowAlternateFormatFallback = !isWindowsPlatform

    const loadWithFallback = (
      target: HTMLVideoElement,
      targetUrl: string,
      allowFallback: boolean,
      onReady: () => void,
      onFailed: () => void,
    ) => {
      clearListeners()

      const ready = () => {
        clearListeners()
        if (cancelled || generationRef.current !== generation) return
        onReady()
      }

      const failed = () => {
        clearListeners()
        if (cancelled || generationRef.current !== generation) return
        if (allowFallback) {
          const alt = altSrcRef.current ?? getAlternateSrcRef.current?.(targetUrl)
          if (alt && alt !== targetUrl) {
            loadWithFallback(target, alt, false, onReady, onFailed)
            return
          }
        }
        onFailed()
      }

      addOnce(target, 'playing', ready)
      addOnce(target, 'error', failed)

      target.currentTime = 0
      target.playbackRate = playbackRateRef.current
      target.src = targetUrl
      target.load()
      target.play().catch(() => {})
    }

    if (isFirstLoad) {
      loadWithFallback(
        front,
        src,
        allowAlternateFormatFallback,
        () => {
          if (!cancelled && generationRef.current === generation) {
            onPlayingRef.current?.()
          }
        },
        () => {
          if (!cancelled && generationRef.current === generation) {
            onErrorRef.current?.(front.error)
          }
        },
      )
      return () => {
        cancelled = true
        clearListeners()
      }
    }

    // Preload next animation on the hidden back buffer and swap only when playing
    loadWithFallback(
      back,
      src,
      allowAlternateFormatFallback,
      () => finishSwap(backIdx),
      () => {
        if (!cancelled && generationRef.current === generation) {
          onErrorRef.current?.(back.error)
        }
      },
    )

    return () => {
      cancelled = true
      clearListeners()
    }
  }, [src])

  // Update playbackRate on existing video elements if changed mid-playback
  useEffect(() => {
    if (videoRefA.current) videoRefA.current.playbackRate = playbackRate
    if (videoRefB.current) videoRefB.current.playbackRate = playbackRate
  }, [playbackRate])

  // Canvas Chroma-Key Render Loop (Windows transparency workaround)
  useEffect(() => {
    if (!useChromaKey) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    let rafId = 0
    let retryCount = 0

    const lowThresh = chromaKeyOptions?.lowThreshold ?? 12
    const highThresh = chromaKeyOptions?.highThreshold ?? 28
    const range = Math.max(1, highThresh - lowThresh)

    const draw = () => {
      const front = activeBufferRef.current === 0 ? videoRefA.current : videoRefB.current
      if (front && front.readyState >= 2 && front.videoWidth > 0 && front.videoHeight > 0) {
        retryCount = 0
        const targetW = canvasWidth ?? canvas.clientWidth ?? front.videoWidth
        const targetH = canvasHeight ?? canvas.clientHeight ?? front.videoHeight
        if (targetW > 0 && targetH > 0 && (canvas.width !== targetW || canvas.height !== targetH)) {
          canvas.width = targetW
          canvas.height = targetH
        }
        if (canvas.width > 0 && canvas.height > 0) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(front, 0, 0, canvas.width, canvas.height)
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const data = frame.data

          for (let i = 0; i < data.length; i += 4) {
            const maxRgb = Math.max(data[i], data[i + 1], data[i + 2])
            if (maxRgb <= lowThresh) {
              data[i + 3] = 0
            } else if (maxRgb < highThresh) {
              const softAlpha = Math.round(((maxRgb - lowThresh) / range) * 255)
              if (softAlpha < data[i + 3]) data[i + 3] = softAlpha
            }
          }
          ctx.putImageData(frame, 0, 0)
        }
      } else if (front && front.src && front.paused) {
        retryCount++
        if (retryCount % 30 === 0) front.play().catch(() => {})
      }
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [useChromaKey, activeBuffer, canvasWidth, canvasHeight, chromaKeyOptions])

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {useChromaKey && (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            transform,
          }}
        />
      )}
      {[0, 1].map((idx) => {
        const isFront = activeBuffer === idx
        const ref = idx === 0 ? videoRefA : videoRefB
        return (
          <video
            key={idx}
            ref={ref}
            autoPlay={isFront}
            loop={loop}
            muted
            playsInline
            preload="auto"
            onError={() => {
              if (isFront) {
                onErrorRef.current?.(ref.current?.error)
              }
            }}
            onEnded={() => {
              if (isFront) {
                onEndedRef.current?.()
              }
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit,
              pointerEvents: 'none',
              visibility: isFront ? 'visible' : 'hidden',
              opacity: useChromaKey ? 0 : 1,
              transform,
            }}
            draggable={draggable}
          />
        )
      })}
    </div>
  )
}
