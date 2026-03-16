import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')

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

describe('Type Safety', () => {
  describe('no_direct_supabase_data_access', () => {
    it('should not use supabase.from() or supabase.rpc() in features', () => {
      const ALLOWLIST = [join(SRC_DIR, 'lib/supabase.ts')]
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        if (ALLOWLIST.includes(filePath)) continue

        const content = readFileSync(filePath, 'utf-8')
        if (/supabase\.from\(/.test(content) || /supabase\.rpc\(/.test(content)) {
          violations.push(relative(SRC_DIR, filePath))
        }
      }

      expect(
        violations,
        `Direct Supabase data access found in features. Use the generated API client instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_raw_fetch_in_features', () => {
    it('should not use raw fetch() calls in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Match fetch( but not .fetch( (method on generated client) and not in comments
          if (/(?<!\w)fetch\(/.test(line) && !line.trimStart().startsWith('//')) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Raw fetch() calls found in features. Use the generated SDK from @/lib/api instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_hardcoded_urls', () => {
    it('should not contain hardcoded http:// or https:// URLs in source', () => {
      const ALLOWLIST = [join(SRC_DIR, 'lib/env.ts'), join(SRC_DIR, 'lib/api-client.ts')]
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        if (ALLOWLIST.includes(filePath)) continue
        // Exclude test files
        if (filePath.includes('.test.') || filePath.includes('.spec.')) continue
        // Exclude generated API client
        if (filePath.includes(`${join('lib', 'api')}/`)) continue

        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
          if (/https?:\/\//.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Hardcoded URLs found. Use env variables via src/lib/env.ts instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('route_constants_enforcement', () => {
    it('should not hardcode route paths in features (ADR-033)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      // Known route segments that should use ROUTES.* constants
      const ROUTE_SEGMENTS = ['servers', 'channels', 'settings', 'auth']
      // Match template literals like `/servers/${` or `/channels/${`
      const routePatterns = ROUTE_SEGMENTS.map(
        (segment) => new RegExp('`[^`]*/' + segment + '/\\$\\{'),
      )

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue

          for (const pattern of routePatterns) {
            if (pattern.test(line)) {
              violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
              break
            }
          }
        }
      }

      expect(
        violations,
        `Hardcoded route paths found. Use ROUTES.* constants from @/lib/routes instead (ADR-033).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('logger_bypass_enforcement', () => {
    it('should not bypass noConsole via biome-ignore outside logger.ts (ADR-042)', () => {
      const AUTHORIZED_FILE = join(SRC_DIR, 'lib/logger.ts')
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        // Only logger.ts is authorized to suppress the noConsole rule
        if (filePath === AUTHORIZED_FILE) continue

        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('biome-ignore lint/suspicious/noConsole')) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Unauthorized noConsole bypass found. Only src/lib/logger.ts may suppress biome noConsole (ADR-042).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_shadcn_imports', () => {
    it('should not import from @/components/ui/ (Task 4.2 — HeroUI migration)', () => {
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue

          if (/from ['"]@\/components\/ui\//.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Shadcn UI imports found. Use HeroUI components instead of @/components/ui/*.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_radix_imports', () => {
    it('should not import @radix-ui packages (Task 4.3 — HeroUI migration)', () => {
      const COMPONENTS_DIR = join(SRC_DIR, 'components')
      const featureFiles = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const componentFiles = getAllFiles(COMPONENTS_DIR, ['.ts', '.tsx'])
      const files = [...featureFiles, ...componentFiles]
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue

          if (/@radix-ui/.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Direct @radix-ui imports found. Use HeroUI components instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_hardcoded_tailwind_colors', () => {
    it('should not use hardcoded Tailwind color classes (Task 4.4 — HeroUI migration)', () => {
      const COMPONENTS_DIR = join(SRC_DIR, 'components')
      const RESIZABLE_HANDLE = join(COMPONENTS_DIR, 'layout/resizable-handle.tsx')
      const featureFiles = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const componentFiles = getAllFiles(COMPONENTS_DIR, ['.ts', '.tsx'])
      const files = [...featureFiles, ...componentFiles]
      const violations: string[] = []

      // Hardcoded color prefixes that should use semantic tokens instead
      const COLOR_PREFIXES = [
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

      // Build a single regex from all prefixes for efficient matching
      const colorPattern = new RegExp(COLOR_PREFIXES.map((p) => p.replace('-', '\\-')).join('|'))

      for (const filePath of files) {
        // Exclude resizable-handle.tsx (layout primitive may need raw colors)
        if (filePath === RESIZABLE_HANDLE) continue

        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
          // Escape hatch: allow explicit override annotation
          if (line.includes('// heroui-color-override')) continue

          if (colorPattern.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Hardcoded Tailwind color classes found. Use HeroUI semantic color tokens (e.g. bg-danger, text-foreground) instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})
