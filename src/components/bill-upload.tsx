'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { uploadBill } from '@/app/(app)/bills/actions'

export function UploadZone() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  async function send(file: File) {
    setState('busy'); setMessage(null); setParseError(null)
    const fd = new FormData()
    fd.set('file', file)
    const res = await uploadBill(fd)
    setMessage(res.message ?? null)
    setParseError(res.parseError ?? null)
    setState(res.ok ? 'done' : 'error')
    if (res.ok && res.billId) router.push(`/bills/${res.billId}` as never)
    else if (res.ok) router.refresh()
  }

  return (
    <section className="panel">
      <h2>Upload a bill</h2>
      <div
        className={`dropzone ${state}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void send(file)
        }}
      >
        <p>Drop the PDF here, or</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          aria-label="Bill PDF"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void send(file)
          }}
        />
        {state === 'busy' ? <p className="muted">Reading the bill…</p> : null}
        {message ? <p className={state === 'error' ? 'issue error' : 'issue'}>{message}</p> : null}
        {parseError ? (
          <p className="issue warn">
            {parseError} The document is stored — open it from the list below and key
            the figures in by hand.
          </p>
        ) : null}
      </div>
    </section>
  )
}
