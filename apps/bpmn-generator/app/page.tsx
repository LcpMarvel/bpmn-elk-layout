'use client'

import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { useChat } from '@/hooks/useChat'
import { useBpmnConverter } from '@/hooks/useBpmnConverter'
import { ChatPanel } from '@/components/ChatPanel'
import { BpmnPreview } from '@/components/BpmnPreview'
import { SettingsModal } from '@/components/SettingsModal'

export default function Home() {
  const { settings, updateSettings, isLoaded, isConfigured } = useSettings()
  const { messages, currentCode, isLoading, error, sendMessage, reset } = useChat(settings)
  const { bpmnXml, convertError, isConverting, convert } = useBpmnConverter()
  const [showSettings, setShowSettings] = useState(false)

  // Convert JSON to BPMN XML when currentCode changes
  useEffect(() => {
    if (currentCode) {
      convert(currentCode)
    }
  }, [currentCode, convert])

  // Show loading state while settings are being loaded
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">BPMN Generator</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-md transition-colors flex items-center gap-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Settings
          </button>
          <button
            onClick={reset}
            className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 rounded-md transition-colors flex items-center gap-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Reset
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left panel - Chat (max 30% width) */}
        <div className="w-[30%] max-w-[30%] border-r flex flex-col">
          <ChatPanel
            messages={messages}
            isLoading={isLoading}
            error={error}
            onSendMessage={sendMessage}
            isConfigured={isConfigured}
          />
        </div>

        {/* Right panel - BPMN Preview (70% width) */}
        <div className="flex-1 flex flex-col">
          <BpmnPreview
            json={currentCode}
            xml={bpmnXml}
            error={convertError}
            isConverting={isConverting}
          />
        </div>
      </main>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSave={updateSettings}
      />
    </div>
  )
}
