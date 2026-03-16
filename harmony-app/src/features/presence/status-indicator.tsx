import type { UserStatus } from '@/lib/api'

interface StatusIndicatorProps {
  status: UserStatus
  size?: 'sm' | 'md' | 'lg'
}

const sizeClass = {
  sm: 'h-2.5 w-2.5',
  md: 'h-3 w-3',
  lg: 'h-3.5 w-3.5',
} as const

const statusColor = {
  online: 'bg-success',
  idle: 'bg-warning',
  dnd: 'bg-danger',
  offline: 'bg-default-300',
} as const

export function StatusIndicator({ status, size = 'md' }: StatusIndicatorProps) {
  return (
    <div
      className={`${sizeClass[size]} ${statusColor[status]} rounded-full border-2 border-content1`}
    />
  )
}
