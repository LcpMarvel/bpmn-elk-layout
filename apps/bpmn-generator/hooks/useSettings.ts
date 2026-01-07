'use client'

import { useState, useEffect, useCallback } from 'react'
import { Settings, DEFAULT_SETTINGS } from '@/types'

const STORAGE_KEY = 'bpmn-generator-settings'

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [isLoaded, setIsLoaded] = useState(false)

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        setSettings({
          ...DEFAULT_SETTINGS,
          ...parsed,
        })
      }
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
    setIsLoaded(true)
  }, [])

  // Save settings to localStorage
  const updateSettings = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
      } catch (error) {
        console.error('Failed to save settings:', error)
      }
      return updated
    })
  }, [])

  // Check if API key is configured
  const isConfigured = settings.apiKey.trim().length > 0

  return {
    settings,
    updateSettings,
    isLoaded,
    isConfigured,
  }
}
