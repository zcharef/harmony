# ADR-034: Error Boundaries Per Feature Route

**Status:** Accepted
**Date:** 2026-03-16

## Context

Without error boundaries, a single component error crashes the entire application:

```typescript
// BAD: no error boundary — one broken component crashes the whole app
function App() {
  return (
    <Layout>
      <ServerNav />      {/* If this throws... */}
      <ChannelSidebar /> {/* ...everything unmounts */}
      <ChatArea />       {/* ...including unrelated components */}
    </Layout>
  );
}

// User sees a blank white screen. No error message. No recovery.
// They must refresh the entire app to continue.
```

React's default behavior on an unhandled error is to unmount the entire component tree. A bug in one feature (e.g., a malformed message in ChatArea) takes down the navigation, sidebar, and every other feature.

## Decision

Each feature route is wrapped in an `<ErrorBoundary>`. Errors are contained to the feature that threw, and the rest of the application remains functional.

```typescript
// GOOD: error boundary per feature route — errors are contained
import { ErrorBoundary } from 'react-error-boundary';

function App() {
  return (
    <Layout>
      <ErrorBoundary fallback={<NavError />}>
        <ServerNav />
      </ErrorBoundary>

      <ErrorBoundary fallback={<SidebarError />}>
        <ChannelSidebar />
      </ErrorBoundary>

      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }) => (
          <div className="flex flex-col items-center gap-4 p-8">
            <h2 className="text-lg font-semibold text-red-400">
              Something went wrong
            </h2>
            <p className="text-sm text-zinc-400">
              {error?.detail ?? error?.message ?? 'An unexpected error occurred'}
            </p>
            <button
              onClick={resetErrorBoundary}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm text-white"
            >
              Try again
            </button>
          </div>
        )}
      >
        <ChatArea />
      </ErrorBoundary>
    </Layout>
  );
}
```

**RFC 9457 integration:** When the API returns an error following RFC 9457 (ADR-008), the error boundary displays the `detail` field for a human-readable explanation:

```typescript
// Error boundary fallback reads RFC 9457 detail field
{error?.detail ?? error?.message ?? 'An unexpected error occurred'}
```

## Consequences

**Positive:**
- A bug in one feature does not crash the entire application
- Users can continue using unaffected features while the broken feature shows an error
- `resetErrorBoundary` allows retry without a full page refresh
- RFC 9457 `detail` field provides a meaningful error message to users

**Negative:**
- More wrapper components in the tree (acceptable overhead)
- Error boundary fallbacks must be designed for each feature area
- Class component limitation: error boundaries must use class components or `react-error-boundary` library

## Enforcement

- **Test (deferred):** Enforcement test will be added once routing is fully implemented — will scan route configuration for `ErrorBoundary` wrappers around each feature route
- **Code review:** New feature routes must include an `ErrorBoundary` wrapper
