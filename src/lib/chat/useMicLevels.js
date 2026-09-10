import { useEffect, useState } from 'react'

const BARS = 9
const FRAME_MS = 66

/**
 * Microphone level meter for the composer's voice mode.
 *
 * When `active`, tries the platform microphone (getUserMedia + Web Audio —
 * no HPOS backend, no transcription) and reports per-bar spectrum levels.
 * When the mic is missing, blocked, or denied, `live` stays false and the
 * bars fall back to a pure CSS animation so voice mode still reads clearly.
 * Everything is torn down when `active` flips off or unmounts.
 */
export function useMicLevels(active) {
  const [levels, setLevels] = useState(() => Array(BARS).fill(0.22))
  const [live, setLive] = useState(false)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    if (!active) return
    let dead = false
    let raf = 0
    let stream = null
    let ctx = null
    let last = 0

    const stopAll = () => {
      if (raf) cancelAnimationFrame(raf)
      try { stream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      try { ctx?.close() } catch { /* ignore */ }
    }

    const loop = (analyser, freq) => (now) => {
      if (dead) return
      raf = requestAnimationFrame(loop(analyser, freq))
      if (now - last < FRAME_MS) return
      last = now
      try {
        analyser.getByteFrequencyData(freq)
      } catch {
        return
      }
      const bins = freq.length
      const next = []
      for (let i = 0; i < BARS; i += 1) {
        const from = Math.floor((i * bins) / BARS)
        const to = Math.max(from + 1, Math.floor(((i + 1) * bins) / BARS))
        let sum = 0
        for (let b = from; b < to; b += 1) sum += freq[b]
        next.push(Math.min(1, (sum / (to - from)) / 255))
      }
      if (!dead) setLevels(next)
    }

    let cancelled = false
    const start = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia) return
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (!AudioCtx) return
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stopAll()
          return
        }
        ctx = new AudioCtx()
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.75
        src.connect(analyser)
        if (cancelled) {
          stopAll()
          return
        }
        setLive(true)
        raf = requestAnimationFrame(loop(analyser, new Uint8Array(analyser.frequencyBinCount)))
      } catch (err) {
        if (!dead && (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')) {
          setDenied(true)
        }
        stopAll()
      }
    }
    start()

    return () => {
      dead = true
      cancelled = true
      stopAll()
      setLive(false)
    }
  }, [active])

  return { levels, live, denied }
}
