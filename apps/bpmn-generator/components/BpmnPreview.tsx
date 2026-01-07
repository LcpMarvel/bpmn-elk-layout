'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

interface BpmnPreviewProps {
  json: string | null
  xml: string | null
  error: string | null
  isConverting: boolean
}

export function BpmnPreview({
  json,
  xml,
  error,
  isConverting,
}: BpmnPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)
  const [viewerError, setViewerError] = useState<string | null>(null)
  const [copiedJson, setCopiedJson] = useState(false)
  const [copiedXml, setCopiedXml] = useState(false)

  // Initialize bpmn-js viewer
  useEffect(() => {
    let mounted = true

    const initViewer = async () => {
      if (!containerRef.current || viewerRef.current) return

      try {
        // Dynamic import of bpmn-js
        const BpmnJS = (await import('bpmn-js')).default

        // Check if still mounted and not already initialized
        if (!mounted || viewerRef.current) return

        const viewer = new BpmnJS({
          container: containerRef.current,
        })
        viewerRef.current = viewer
      } catch (err) {
        console.error('Failed to initialize BPMN viewer:', err)
        if (mounted) {
          setViewerError('Failed to initialize BPMN viewer')
        }
      }
    }

    initViewer()

    return () => {
      mounted = false
      if (viewerRef.current) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [])

  // Render BPMN XML when it changes
  useEffect(() => {
    const renderXml = async () => {
      if (!viewerRef.current || !xml) {
        return
      }

      setViewerError(null)

      try {
        await viewerRef.current.importXML(xml)
        const canvas = viewerRef.current.get('canvas')
        canvas.zoom('fit-viewport')
      } catch (err) {
        console.error('Failed to render BPMN:', err)
        setViewerError(err instanceof Error ? err.message : 'Failed to render BPMN')
      }
    }

    renderXml()
  }, [xml])

  const handleCopyJson = useCallback(async () => {
    if (!json) return
    try {
      await navigator.clipboard.writeText(json)
      setCopiedJson(true)
      setTimeout(() => setCopiedJson(false), 2000)
    } catch (err) {
      console.error('Failed to copy JSON:', err)
    }
  }, [json])

  const handleCopyXml = useCallback(async () => {
    if (!xml) return
    try {
      await navigator.clipboard.writeText(xml)
      setCopiedXml(true)
      setTimeout(() => setCopiedXml(false), 2000)
    } catch (err) {
      console.error('Failed to copy XML:', err)
    }
  }, [xml])

  const displayError = error || viewerError

  return (
    <div className="flex flex-col h-full">
      {/* Preview area */}
      <div className="flex-1 relative bg-gray-50">
        {/* Loading state */}
        {isConverting && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
            <div className="flex items-center gap-2 text-gray-500">
              <svg
                className="animate-spin h-5 w-5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Converting...</span>
            </div>
          </div>
        )}

        {/* Error display */}
        {displayError && (
          <div className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 rounded-md p-3 z-10">
            <p className="text-red-600 text-sm">{displayError}</p>
          </div>
        )}

        {/* Empty state */}
        {!json && !isConverting && !displayError && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400">
            <p>BPMN preview will appear here</p>
          </div>
        )}

        {/* BPMN viewer container */}
        <div
          ref={containerRef}
          className="bpmn-container absolute inset-0"
          style={{ visibility: xml && !displayError ? 'visible' : 'hidden' }}
        />
      </div>

      {/* Action buttons */}
      <div className="border-t p-3 flex gap-2 justify-end bg-white">
        <button
          onClick={handleCopyJson}
          disabled={!json}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {copiedJson ? 'Copied!' : 'Copy JSON'}
        </button>
        <button
          onClick={handleCopyXml}
          disabled={!xml}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {copiedXml ? 'Copied!' : 'Copy BPMN'}
        </button>
      </div>
    </div>
  )
}
