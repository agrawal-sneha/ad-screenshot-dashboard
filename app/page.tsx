'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

const TEAM_MEMBERS = [
  'Somil', 'Tanveer', 'Avishek', 'Rebika',
  'Hemanth', 'Bijit', 'Sneha', 'Manasvi', 'Ananya',
  'Sakshi', 'Kalyan', 'Aashwin', 'Paritosh',
  'Abhinav', 'Rishab', 'Sneha Ag', 'Rao',
]

type Row = [string, string, string, string] // date, brand, person, link
type Attachment = { id: string; key: string; file: File; preview: string }

export default function Dashboard() {
  const [person, setPerson] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loadingRows, setLoadingRows] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchRows = useCallback(async () => {
    setLoadingRows(true)
    try {
      const res = await fetch('/api/screenshots')
      const json = await res.json()
      if (json.rows) setRows(json.rows)
    } catch {
      // silent fail on table load
    } finally {
      setLoadingRows(false)
    }
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  const handleFiles = (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList)
    const images = incoming.filter(f => f.type.startsWith('image/'))
    const rejected = incoming.length - images.length
    if (rejected > 0) showToast(`Skipped ${rejected} non-image file${rejected > 1 ? 's' : ''}`, false)
    if (images.length === 0) return

    const additions: Attachment[] = images.map(f => ({
      id: `${f.name}:${f.size}:${f.lastModified}:${Math.random().toString(36).slice(2)}`,
      key: `${f.name}:${f.size}:${f.lastModified}`,
      file: f,
      preview: '',
    }))

    setAttachments(prev => {
      const seen = new Set(prev.map(a => a.key))
      const merged = [...prev]
      for (const a of additions) {
        if (seen.has(a.key)) continue
        seen.add(a.key)
        merged.push(a)
      }
      return merged
    })

    additions.forEach(att => {
      const reader = new FileReader()
      reader.onload = e => {
        const url = e.target?.result as string
        setAttachments(cur => cur.map(a => (a.id === att.id ? { ...a, preview: url } : a)))
      }
      reader.readAsDataURL(att.file)
    })
  }

  const removeAttachment = (id: string) =>
    setAttachments(prev => prev.filter(a => a.id !== id))

  const clearAll = () => setAttachments([])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
  }, [])

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = () => setDragging(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (attachments.length === 0) return showToast('Please select at least one screenshot', false)
    if (!person) return showToast('Please select your name', false)

    setUploading(true)
    try {
      const fd = new FormData()
      attachments.forEach(a => fd.append('file', a.file))
      fd.append('person', person)

      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const json = await res.json()

      if (!res.ok) {
        // Handle different error types with appropriate colors
        if (res.status === 409) {
          // Duplicate screenshot - red toast
          showToast(`Duplicate: ${json.error}`, false)
        } else {
          // Other errors - red toast
          showToast(json.error || 'Upload failed', false)
        }
        return
      }

      const uploaded: { brand: string }[] = json.uploaded ?? []
      const failed: { index: number; name: string; error: string }[] = json.failed ?? []

      if (uploaded.length === 0) {
        showToast(failed.length ? `All ${failed.length} upload${failed.length > 1 ? 's' : ''} failed` : 'Nothing uploaded', false)
      } else {
        const brands = uploaded.map(u => u.brand).filter(Boolean)
        const shown = brands.slice(0, 3).join(', ')
        const more = brands.length > 3 ? ` +${brands.length - 3}` : ''
        const okMsg = uploaded.length === 1
          ? `Uploaded! Brand: ${brands[0] ?? 'Unknown'}`
          : `Uploaded ${uploaded.length} screenshots (${shown}${more})`
        showToast(failed.length ? `${okMsg} · ${failed.length} failed` : okMsg, failed.length === 0)
      }

      // Clear on full success; otherwise keep only the failed files (by upload index) for retry.
      if (failed.length === 0) {
        setAttachments([])
      } else {
        const failedIdx = new Set<number>(failed.map(f => f.index))
        setAttachments(prev => prev.filter((_, i) => failedIdx.has(i)))
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
      fetchRows()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed', false)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 002 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Ad Screenshot Dashboard</h1>
            <p className="text-xs text-gray-500">Upload screenshots — brand is detected automatically</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Upload card */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Upload Screenshot</h2>
          <form onSubmit={onSubmit} className="space-y-4">
            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              className={`relative border-2 border-dashed rounded-lg cursor-pointer transition-colors
                ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = '' }}
              />
              {attachments.length > 0 ? (
                <div className="p-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {attachments.map(att => (
                      <div key={att.id} className="relative group border border-gray-200 rounded-md overflow-hidden bg-gray-50">
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); removeAttachment(att.id) }}
                          className="absolute top-1 right-1 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/60 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                          aria-label={`Remove ${att.file.name}`}
                        >
                          ✕
                        </button>
                        {att.preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={att.preview} alt={att.file.name} className="h-24 w-full object-cover" />
                        ) : (
                          <div className="h-24 w-full flex items-center justify-center text-gray-300">
                            <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                          </div>
                        )}
                        <div className="px-2 py-1.5">
                          <p className="text-xs font-medium text-gray-700 truncate" title={att.file.name}>{att.file.name}</p>
                          <p className="text-[11px] text-gray-400">{(att.file.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      {attachments.length} file{attachments.length > 1 ? 's' : ''} selected · click to add more
                    </span>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); clearAll() }}
                      className="text-red-500 hover:text-red-700"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center">
                  <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25A2.25 0 005.25 21h13.5A2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                  <p className="mt-2 text-sm text-gray-600">
                    <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
                  </p>
                  <p className="text-xs text-gray-400 mt-1">PNG, JPG, WEBP, GIF up to 10MB · multiple allowed</p>
                </div>
              )}
            </div>

            {/* Person select + submit */}
            <div className="flex gap-3">
              <select
                value={person}
                onChange={e => setPerson(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">Select your name...</option>
                {TEAM_MEMBERS.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={uploading || attachments.length === 0 || !person}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {uploading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Uploading...
                  </>
                ) : attachments.length > 1 ? `Upload ${attachments.length}` : 'Upload'}
              </button>
            </div>
          </form>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-800">All Screenshots</h2>
            <button onClick={fetchRows} className="text-xs text-blue-600 hover:underline">Refresh</button>
          </div>

          {loadingRows ? (
            <div className="py-12 text-center text-sm text-gray-400">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400">No screenshots yet. Upload one above!</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3 text-left">Date</th>
                    <th className="px-6 py-3 text-left">Brand</th>
                    <th className="px-6 py-3 text-left">Shared by</th>
                    <th className="px-6 py-3 text-left">Drive Link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 text-gray-600 whitespace-nowrap">{row[0] || '—'}</td>
                      <td className="px-6 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {row[1] || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-700 font-medium">{row[2] || '—'}</td>
                      <td className="px-6 py-3">
                        {row[3] ? (
                          <a
                            href={row[3]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            View
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm text-white transition-all
          ${toast.ok ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
