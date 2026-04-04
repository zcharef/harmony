import { Select, SelectItem } from '@heroui/react'
import { Room, RoomEvent } from 'livekit-client'
import { Mic, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

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
export function AudioDeviceSelector() {
  const room = useVoiceConnectionStore((s) => s.room)

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

      // WHY: Sync selected state with room's active devices after enumeration.
      if (room !== null) {
        const currentInput = room.getActiveDevice('audioinput')
        const currentOutput = room.getActiveDevice('audiooutput')
        if (currentInput !== undefined) setActiveInputId(currentInput)
        if (currentOutput !== undefined) setActiveOutputId(currentOutput)
      }
    } catch (err: unknown) {
      logger.error('voice_device_enumeration_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [room])

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

  function switchDevice(kind: MediaDeviceKind, selection: Iterable<string | number>) {
    const first = [...selection][0]
    if (first === undefined || room === null) return
    const deviceId = String(first)

    // WHY: Clear previous error on new attempt so stale feedback doesn't linger.
    setSwitchError(null)

    room.switchActiveDevice(kind, deviceId).then(
      () => {
        if (kind === 'audioinput') setActiveInputId(deviceId)
        else setActiveOutputId(deviceId)
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`voice_switch_${kind}_failed`, {
          error: message,
          deviceId,
        })
        // WHY (ADR-028): Explicit user action (device switch) gets inline
        // feedback proportional to the action. No toast — inline text is
        // sufficient for a dropdown selection failure.
        setSwitchError(`Failed to switch ${kind === 'audioinput' ? 'microphone' : 'speaker'}`)
      },
    )
  }

  // WHY: No room means no active voice connection — nothing to configure.
  if (room === null) return null

  return (
    <div className="flex flex-col gap-3">
      {switchError !== null && (
        <p className="text-sm text-danger" data-test="device-switch-error">
          {switchError}
        </p>
      )}
      <Select
        aria-label="Microphone"
        label="Microphone"
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

      <Select
        aria-label="Speaker"
        label="Speaker"
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
    </div>
  )
}
