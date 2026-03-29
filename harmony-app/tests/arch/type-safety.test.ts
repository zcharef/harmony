import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')
const COMPONENTS_DIR = join(SRC_DIR, 'components')

/**
 * Architecture tests for type safety and API access patterns.
 *
 * These validate rules that static analysis alone cannot enforce:
 * - No direct Supabase data access from features
 * - No raw fetch() calls in features (must use generated SDK)
 * - No hardcoded URLs in source code
 *
 * Run with: just test-arch
 */

function getAllFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/** WHY: Shared line-scanning helper reduces cognitive complexity in each test. */
function scanFilesForViolations(
  files: string[],
  matcher: (line: string, lineIndex: number, filePath: string) => string | null,
): string[] {
  const violations: string[] = []
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const result = matcher(lines[i], i, filePath)
      if (result !== null) violations.push(result)
    }
  }
  return violations
}

/** WHY: Scans full file content (not line-by-line) for pattern matches. */
function scanFilesForContentViolations(
  files: string[],
  patterns: RegExp[],
  excludePaths: string[] = [],
): string[] {
  const violations: string[] = []
  for (const filePath of files) {
    if (excludePaths.includes(filePath)) continue
    const content = readFileSync(filePath, 'utf-8')
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        violations.push(relative(SRC_DIR, filePath))
        break
      }
    }
  }
  return violations
}

describe('Type Safety', () => {
  describe('no_direct_supabase_data_access', () => {
    it('should not use supabase.from() or supabase.rpc() in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations = scanFilesForContentViolations(files, [
        /supabase\.from\(/,
        /supabase\.rpc\(/,
      ])

      expect(
        violations,
        `Direct Supabase data access found in features. Use the generated API client instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_raw_fetch_in_features', () => {
    it('should not use raw fetch() calls in features', () => {
      // WHY allowlist: auth-provider syncs the Supabase session with the Rust API
      // before the generated SDK is configured. This raw fetch is the bootstrap call.
      const ALLOWLIST = [join(FEATURES_DIR, 'auth/auth-provider.tsx')]
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx']).filter((f) => !ALLOWLIST.includes(f))

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/(?<!\w)fetch\(/.test(line)) return `${relative(SRC_DIR, filePath)}:${i + 1}`
        return null
      })

      expect(
        violations,
        `Raw fetch() calls found in features. Use the generated SDK from @/lib/api instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_hardcoded_urls', () => {
    it('should not contain hardcoded http:// or https:// URLs in source', () => {
      const ALLOWLIST = [
        join(SRC_DIR, 'lib/env.ts'),
        join(SRC_DIR, 'lib/api-client.ts'),
        // WHY: About page has static GitHub project links (not API URLs that vary by env).
        join(SRC_DIR, 'components/layout/about-page.tsx'),
      ]
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx']).filter((f) => {
        if (ALLOWLIST.includes(f)) return false
        if (f.includes('.test.') || f.includes('.spec.')) return false
        if (f.includes(`${join('lib', 'api')}/`)) return false
        return true
      })

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/https?:\/\//.test(line)) return `${relative(SRC_DIR, filePath)}:${i + 1}`
        return null
      })

      expect(
        violations,
        `Hardcoded URLs found. Use env variables via src/lib/env.ts instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('route_constants_enforcement', () => {
    it('should not hardcode route paths in features (ADR-033)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const ROUTE_SEGMENTS = ['servers', 'channels', 'settings', 'auth']
      const routePatterns = ROUTE_SEGMENTS.map(
        (segment) => new RegExp(`\`[^\`]*/${segment}/\\$\\{`),
      )

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        return matchAnyPattern(line, routePatterns, filePath, i)
      })

      expect(
        violations,
        `Hardcoded route paths found. Use ROUTES.* constants from @/lib/routes instead (ADR-033).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('logger_bypass_enforcement', () => {
    it('should not bypass noConsole via biome-ignore outside logger.ts (ADR-042)', () => {
      const AUTHORIZED_FILE = join(SRC_DIR, 'lib/logger.ts')
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx']).filter((f) => f !== AUTHORIZED_FILE)

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (line.includes('biome-ignore lint/suspicious/noConsole')) {
          return `${relative(SRC_DIR, filePath)}:${i + 1}`
        }
        return null
      })

      expect(
        violations,
        `Unauthorized noConsole bypass found. Only src/lib/logger.ts may suppress biome noConsole (ADR-042).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_shadcn_imports', () => {
    it('should not import from @/components/ui/ (Task 4.2 — HeroUI migration)', () => {
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/from ['"]@\/components\/ui\//.test(line)) {
          return `${relative(SRC_DIR, filePath)}:${i + 1}`
        }
        return null
      })

      expect(
        violations,
        `Shadcn UI imports found. Use HeroUI components instead of @/components/ui/*.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_radix_imports', () => {
    it('should not import @radix-ui packages (Task 4.3 — HeroUI migration)', () => {
      const featureFiles = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const componentFiles = getAllFiles(COMPONENTS_DIR, ['.ts', '.tsx'])
      const files = [...featureFiles, ...componentFiles]

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/@radix-ui/.test(line)) return `${relative(SRC_DIR, filePath)}:${i + 1}`
        return null
      })

      expect(
        violations,
        `Direct @radix-ui imports found. Use HeroUI components instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_hardcoded_tailwind_colors', () => {
    it('should not use hardcoded Tailwind color classes (Task 4.4 — HeroUI migration)', () => {
      const RESIZABLE_HANDLE = join(COMPONENTS_DIR, 'layout/resizable-handle.tsx')
      const featureFiles = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const componentFiles = getAllFiles(COMPONENTS_DIR, ['.ts', '.tsx'])
      const files = [...featureFiles, ...componentFiles].filter((f) => f !== RESIZABLE_HANDLE)

      const violations = scanFilesForViolations(files, matchHardcodedColor)

      expect(
        violations,
        `Hardcoded Tailwind color classes found. Use HeroUI semantic color tokens (e.g. bg-danger, text-foreground) instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})

function matchAnyPattern(
  line: string,
  patterns: RegExp[],
  filePath: string,
  lineIndex: number,
): string | null {
  for (const pattern of patterns) {
    if (pattern.test(line)) return `${relative(SRC_DIR, filePath)}:${lineIndex + 1}`
  }
  return null
}

// WHY: Hardcoded color prefixes that should use semantic tokens instead.
const HARDCODED_COLOR_PATTERN = new RegExp(
  [
    'bg-emerald-',
    'bg-red-',
    'bg-amber-',
    'bg-zinc-',
    'bg-gray-',
    'bg-slate-',
    'text-emerald-',
    'text-red-',
    'text-amber-',
    'text-zinc-',
    'text-gray-',
    'text-slate-',
    'text-white',
    'border-emerald-',
    'border-red-',
    'border-amber-',
    'border-zinc-',
  ]
    .map((p) => p.replace('-', '\\-'))
    .join('|'),
)

function matchHardcodedColor(line: string, lineIndex: number, filePath: string): string | null {
  if (isCommentLine(line)) return null
  if (line.includes('// heroui-color-override')) return null
  if (HARDCODED_COLOR_PATTERN.test(line)) return `${relative(SRC_DIR, filePath)}:${lineIndex + 1}`
  return null
}
