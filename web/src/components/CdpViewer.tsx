import { useEffect, useRef, useCallback, useState } from 'react'

/**
 * CdpViewer — live browser view via CDP screencast.
 *
 * Connects directly to the CDP screencast proxy running in the ECS task
 * (via Caddy WSS on the sslip.io domain). Receives JPEG frames and
 * renders them on a canvas. Forwards mouse/keyboard events back.
 *
 * Props:
 *   wsUrl  — WebSocket URL of the CDP proxy (e.g. wss://10-0-50-123.sslip.io)
 *   width  — canvas width  (default 1280)
 *   height — canvas height (default 720)
 */
interface CdpViewerProps {
  wsUrl: string
  width?: number
  height?: number
}

export default function CdpViewer({
  wsUrl,
  width = 1280,
  height = 720,
}: CdpViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>('connecting')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Connect to the CDP screencast proxy ─────────────────────────────
  useEffect(() => {
    if (!wsUrl) return

    setStatus('connecting')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      // Send config to the CDP proxy
      ws.send(JSON.stringify({ quality: 60, maxWidth: width, maxHeight: height }))
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // JSON control message
        try {
          const msg = JSON.parse(event.data)
          if (msg.event === 'connected') {
            setStatus('connected')
          } else if (msg.event === 'error') {
            setStatus('error')
            setErrorMsg(msg.message || 'Unknown error')
          }
        } catch { /* ignore */ }
      } else {
        // Binary JPEG frame — render on canvas
        const blob = new Blob([event.data], { type: 'image/jpeg' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          const ctx = canvasRef.current?.getContext('2d')
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height)
          }
          URL.revokeObjectURL(url)
        }
        img.src = url
      }
    }

    ws.onerror = () => {
      setStatus('error')
      setErrorMsg('WebSocket connection failed')
    }

    ws.onclose = () => {
      setStatus((prev) => prev === 'error' ? prev : 'closed')
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [wsUrl, width, height])

  // ── Forward mouse events ────────────────────────────────────────────
  const scaleCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: Math.round((e.clientX - rect.left) * (width / rect.width)),
        y: Math.round((e.clientY - rect.top) * (height / rect.height)),
      }
    },
    [width, height],
  )

  const sendInput = useCallback((data: object) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
    }
  }, [])

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = scaleCoords(e)
      sendInput({ type: 'mouseMoved', x, y })
    },
    [scaleCoords, sendInput],
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = scaleCoords(e)
      sendInput({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    },
    [scaleCoords, sendInput],
  )

  const onMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = scaleCoords(e)
      sendInput({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    },
    [scaleCoords, sendInput],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const { x, y } = scaleCoords(e)
      sendInput({ type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY })
    },
    [scaleCoords, sendInput],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      sendInput({ type: 'keyDown', key: e.key, code: e.code, text: e.key.length === 1 ? e.key : '' })
    },
    [sendInput],
  )

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      sendInput({ type: 'keyUp', key: e.key, code: e.code })
    },
    [sendInput],
  )

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: width }}>
      {status === 'connecting' && (
        <div style={overlayStyle}>
          <span>Connecting to browser...</span>
        </div>
      )}
      {status === 'error' && (
        <div style={overlayStyle}>
          <span>Connection error: {errorMsg}</span>
        </div>
      )}
      {status === 'closed' && (
        <div style={overlayStyle}>
          <span>Browser session ended</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        tabIndex={0}
        style={{
          width: '100%',
          height: 'auto',
          cursor: 'default',
          outline: 'none',
          borderRadius: 8,
          border: '1px solid #334155',
          background: '#0f172a',
        }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      />
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(15, 23, 42, 0.85)',
  color: '#94a3b8',
  fontSize: 14,
  borderRadius: 8,
  zIndex: 1,
}
