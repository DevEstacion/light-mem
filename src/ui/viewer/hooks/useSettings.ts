import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { authFetch } from '../utils/api';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    authFetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return res.json();
      })
      .then(data => {
        setSettings({
          LIGHT_MEM_MODEL: data.LIGHT_MEM_MODEL ?? DEFAULT_SETTINGS.LIGHT_MEM_MODEL,
          LIGHT_MEM_CONTEXT_OBSERVATIONS: data.LIGHT_MEM_CONTEXT_OBSERVATIONS ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_OBSERVATIONS,
          LIGHT_MEM_WORKER_PORT: data.LIGHT_MEM_WORKER_PORT ?? DEFAULT_SETTINGS.LIGHT_MEM_WORKER_PORT,
          LIGHT_MEM_WORKER_HOST: data.LIGHT_MEM_WORKER_HOST ?? DEFAULT_SETTINGS.LIGHT_MEM_WORKER_HOST,

          LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS: data.LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS,
          LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS: data.LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS,
          LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: data.LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT,
          LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: data.LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT,

          LIGHT_MEM_CONTEXT_FULL_COUNT: data.LIGHT_MEM_CONTEXT_FULL_COUNT ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_FULL_COUNT,
          LIGHT_MEM_CONTEXT_FULL_FIELD: data.LIGHT_MEM_CONTEXT_FULL_FIELD ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_FULL_FIELD,
          LIGHT_MEM_CONTEXT_SESSION_COUNT: data.LIGHT_MEM_CONTEXT_SESSION_COUNT ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SESSION_COUNT,

          LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY: data.LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY,
          LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE: data.LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE ?? DEFAULT_SETTINGS.LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE,
        });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    try {
      const response = await authFetch(API_ENDPOINTS.SETTINGS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });

      if (!response.ok) {
        setSaveStatus(`✗ Error: ${response.status === 401 ? 'Unauthorized' : response.statusText}`);
        setIsSaving(false);
        return;
      }

      const result = await response.json();

      if (result.success) {
        setSettings(newSettings);
        setSaveStatus('✓ Saved');
        setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
      } else {
        setSaveStatus(`✗ Error: ${result.error}`);
      }
    } catch (error) {
      setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
