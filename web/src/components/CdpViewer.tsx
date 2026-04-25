import { useEffect, useRef, useCallback, useState } from 'react'

/**
 * CdpViewer — live browser view via CDP screencast.
 *
 * Connects to the agent's WebSocket endpoint, sends the Chrome CDP host,
 * and renders incoming JPEG frames on a canvas.  Forwards mouse/keyboard
 * events back so the user can interact with the browser.
 *
 * Props:
 *   wsUrl    — WebSocket URL of the agent's screencast proxy (e.g. ws://localhost:8080/ws/screencast)
 *   cdpHost  — IP of the ECS task running Chrome (from start_session response)
 *   cdpPort  — Chrome CDP port (default 9222)
 *   width    — canvas width  (default 1280)
 *   height   — canvas height (default 720)
 */
interface CdpViewerProps {
  wsUrl: string
  cdpHost: string
  cdpPort?: number
  width?: number
  height?: number
}

export default function CdpViewer({
  wsUrl,
  cdpHost,
  cdpPort = 9222,
  width = 1280,
  height = 720,
}: CdpViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>('connecting')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Connect to the agent's screencast WebSocket ─────────────────────
  useEffect(() => {
    if (!wsUrl || !cdpHost) return

    setStatus('connecting')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      // Send initial config
      ws.send(JSON.stringify({
        cdp_host: cdpHost,
        cdp_port: cdpPort,
        quality: 60,
        maxWidth: width,
        maxHeight: height,
      }))
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
      if (status !== 'error') setStatus('closed')
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [wsUrl, cdpHost, cdpPort, width, height])

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

  // ── Forward keyboard events ─────────────────────────────────────────
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
