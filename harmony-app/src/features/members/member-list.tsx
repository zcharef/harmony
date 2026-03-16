import { Users } from 'lucide-react'

/**
 * WHY: The members API endpoint doesn't exist yet in the backend.
 * This component shows a placeholder until the endpoint is implemented
 * and added to the OpenAPI spec. At that point, a useMembers() hook
 * will be created following the same pattern as useServers/useChannels.
 */
export function MemberList() {
  return (
    <div className="flex h-full flex-col bg-default-100">
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
        <Users className="h-10 w-10 text-default-300" />
        <p className="text-center text-sm text-default-500">Members will appear here</p>
      </div>
    </div>
  )
}
