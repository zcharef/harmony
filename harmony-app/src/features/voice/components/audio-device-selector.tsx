import { Select, SelectItem } from '@heroui/react'
import { Room, RoomEvent } from 'livekit-client'
import { Mic, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

interface DeviceInfo {
  deviceId: string
  label: string
}

/**
 * WHY: Provides mic and speaker selection dropdowns that integrate with the
 * LiveKit room's device management. Uses Room.getLocalDevices (static) for
 * enumeration and room.switchActiveDevice (instance) for switching.
 * Refreshes the device list on RoomEvent.MediaDevicesChanged so hot-plugged
 * devices appear immediately.
 */
/**
 * WHY optional `kind`: the connected-only audio-settings popover renders BOTH
 * selects (omit the prop), while the pre-call user-panel chevrons render a
 * single kind. Omitted = both (backwards-compatible).
 */
export function AudioDeviceSelector({ kind }: { kind?: 'audioinput' | 'audiooutput' } = {}) {
  const { t } = useTranslation('voice')
  const room = useVoiceConnectionStore((s) => s.room)
  const setPreferredDevice = useVoiceConnectionStore((s) => s.setPreferredDevice)
  const clearDeviceFallback = useVoiceConnectionStore((s) => s.clearDeviceFallback)
  const preferredAudioInputId = useVoiceConnectionStore((s) => s.preferredAudioInputId)
  const preferredAudioOutputId = useVoiceConnectionStore((s) => s.preferredAudioOutputId)

  const [audioInputs, setAudioInputs] = useState<DeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<DeviceInfo[]>([])
  const [activeInputId, setActiveInputId] = useState<string>('')
  const [activeOutputId, setActiveOutputId] = useState<string>('')
  const [switchError, setSwitchError] = useState<string | null>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const [inputs, outputs] = await Promise.all([
        Room.getLocalDevices('audioinput'),
        Room.getLocalDevices('audiooutput'),
      ])

      setAudioInputs(
        inputs.map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone (${d.deviceId.slice(0, 8)})`,
        })),
      )
      setAudioOutputs(
        outputs.map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker (${d.deviceId.slice(0, 8)})`,
        })),
      )

      // WHY: Prefer stored preferences over room.getActiveDevice(). During token
      // refresh, restorePreferredDevices() is in-flight (async switchActiveDevice)
      // while this callback fires concurrently. room.getActiveDevice() returns
      // the system default at that instant, causing the dropdown to flash/revert.
      // The store is the SSoT for the user's intent; the Room is the SSoT for
      // hardware state — and hardware state is mid-transition during refresh.
      const inputId =
        preferredAudioInputId ?? (room !== null ? room.getActiveDevice('audioinput') : undefined)
      const outputId =
        preferredAudioOutputId ?? (room !== null ? room.getActiveDevice('audiooutput') : undefined)

      if (inputId !== undefined) setActiveInputId(inputId)
      if (outputId !== undefined) setActiveOutputId(outputId)
    } catch (err: unknown) {
      logger.error('voice_device_enumeration_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [room, preferredAudioInputId, preferredAudioOutputId])

  // WHY: Enumerate devices on mount and whenever the room reference changes.
  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  // WHY: Listen for hot-plug events so newly connected devices appear immediately.
  useEffect(() => {
    if (room === null) return

    const handler = () => {
      void refreshDevices()
    }

    room.on(RoomEvent.MediaDevicesChanged, handler)

    return () => {
      room.off(RoomEvent.MediaDevicesChanged, handler)
    }
  }, [room, refreshDevices])

  function switchDevice(
    deviceKind: 'audioinput' | 'audiooutput',
    selection: Iterable<string | number>,
  ) {
    const first = [...selection][0]
    if (first === undefined) return
    const deviceId = String(first)

    // WHY: Clear previous error on new attempt so stale feedback doesn't linger.
    setSwitchError(null)

    // WHY: Pre-call (room === null) there is no live session to switch — just
    // persist the choice; the store applies it on the next join via
    // restorePreferredDevices. Enumeration already works room-less.
    if (room === null) {
      if (deviceKind === 'audioinput') setActiveInputId(deviceId)
      else setActiveOutputId(deviceId)
      setPreferredDevice(deviceKind, deviceId)
      clearDeviceFallback()
      return
    }

    room.switchActiveDevice(deviceKind, deviceId).then(
      () => {
        if (deviceKind === 'audioinput') setActiveInputId(deviceId)
        else setActiveOutputId(deviceId)
        setPreferredDevice(deviceKind, deviceId)
        // WHY: The user just picked a device deliberately — the "fell back to
        // default" notice no longer describes the current state.
        clearDeviceFallback()
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`voice_switch_${deviceKind}_failed`, {
          error: message,
          deviceId,
        })
        // WHY (ADR-028): Explicit user action (device switch) gets inline
        // feedback proportional to the action. No toast — inline text is
        // sufficient for a dropdown selection failure.
        setSwitchError(
          deviceKind === 'audioinput' ? t('switchMicrophoneFailed') : t('switchSpeakerFailed'),
        )
      },
    )
  }

  // WHY: `kind` scopes the render to a single select (pre-call chevron popover);
  // omitted renders both (connected audio-settings popover).
  const showInput = kind === undefined || kind === 'audioinput'
  const showOutput = kind === undefined || kind === 'audiooutput'

  return (
    <div className="flex flex-col gap-3">
      {switchError !== null && (
        <p className="text-sm text-danger" data-test="device-switch-error">
          {switchError}
        </p>
      )}
      {showInput && (
        <Select
          aria-label={t('microphone')}
          label={t('microphone')}
          size="sm"
          startContent={<Mic className="h-4 w-4 text-default-500" />}
          selectedKeys={activeInputId !== '' ? new Set([activeInputId]) : new Set<string>()}
          onSelectionChange={(selection) => switchDevice('audioinput', selection)}
          data-test="audio-input-select"
        >
          {audioInputs.map((device) => (
            <SelectItem key={device.deviceId}>{device.label}</SelectItem>
          ))}
        </Select>
      )}

      {showOutput && (
        <Select
          aria-label={t('speaker')}
          label={t('speaker')}
          size="sm"
          startContent={<Volume2 className="h-4 w-4 text-default-500" />}
          selectedKeys={activeOutputId !== '' ? new Set([activeOutputId]) : new Set<string>()}
          onSelectionChange={(selection) => switchDevice('audiooutput', selection)}
          data-test="audio-output-select"
        >
          {audioOutputs.map((device) => (
            <SelectItem key={device.deviceId}>{device.label}</SelectItem>
          ))}
        </Select>
      )}
    </div>
  )
}
