'use client'

import { useState, useEffect, useCallback } from 'react'
import { BpmnElkLayout } from 'bpmn-elk-layout'

interface UseBpmnConverterReturn {
  bpmnXml: string | null
  convertError: string | null
  isConverting: boolean
  convert: (json: string) => Promise<void>
}

export function useBpmnConverter(): UseBpmnConverterReturn {
  const [bpmnXml, setBpmnXml] = useState<string | null>(null)
  const [convertError, setConvertError] = useState<string | null>(null)
  const [isConverting, setIsConverting] = useState(false)
  const [converter, setConverter] = useState<BpmnElkLayout | null>(null)

  // Initialize converter on mount
  useEffect(() => {
    setConverter(new BpmnElkLayout())
  }, [])

  const convert = useCallback(
    async (json: string) => {
      if (!converter || !json) {
        setBpmnXml(null)
        setConvertError(null)
        return
      }

      setIsConverting(true)
      setConvertError(null)

      try {
        // Parse and validate JSON
        const parsed = JSON.parse(json)

        // Convert to BPMN XML
        const xml = await converter.to_bpmn(parsed)
        setBpmnXml(xml)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Conversion failed'
        setConvertError(errorMessage)
        setBpmnXml(null)
      } finally {
        setIsConverting(false)
      }
    },
    [converter]
  )

  return {
    bpmnXml,
    convertError,
    isConverting,
    convert,
  }
}
