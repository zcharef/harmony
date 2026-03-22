import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')

/**
 * Architecture tests for React coding patterns.
 *
 * These validate rules that enforce consistency and prevent common pitfalls:
 * - No inline styles in feature code
 * - Barrel exports must be pure re-exports (no logic)
 * - No reset() inside useEffect (load-then-render pattern required)
 * - No complex boolean state combinations with negation
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

describe('React Patterns', () => {
  describe('no_inline_styles', () => {
    it('should not use inline styles in tsx files', () => {
      // WHY allowlist: @tanstack/react-virtual REQUIRES inline styles for dynamic
      // pixel positioning (getTotalSize, translateY). No Tailwind equivalent exists.
      const ALLOWLIST = [join(SRC_DIR, 'features/chat/chat-area.tsx')]
      const files = getAllFiles(SRC_DIR, ['.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        if (ALLOWLIST.includes(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
          if (/style=\{\{/.test(line) || /style=\{[^{]/.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Inline styles found. Use Tailwind CSS classes instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_logic_in_barrel_exports', () => {
    it('should only contain re-exports in feature index.ts files', () => {
      if (!existsSync(FEATURES_DIR)) return

      const featureDirs = readdirSync(FEATURES_DIR).filter((name) =>
        statSync(join(FEATURES_DIR, name)).isDirectory(),
      )

      const LOGIC_PATTERNS = [
        /\buseState\b/,
        /\buseEffect\b/,
        /\buseQuery\b/,
        /\buseMutation\b/,
        /\bReact\./,
        /<[A-Z]/,
        /=>/,
        /\bfunction\s+/,
      ]

      const violations: string[] = []

      for (const featureName of featureDirs) {
        const indexPath = join(FEATURES_DIR, featureName, 'index.ts')
        if (!existsSync(indexPath)) continue

        const content = readFileSync(indexPath, 'utf-8')
        const lines = content.split('\n').filter((line) => line.trim().length > 0)

        for (const line of lines) {
          const trimmed = line.trim()
          // Skip empty lines and comments
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue
          }
          // Every non-comment line must be an export statement (re-export)
          if (!trimmed.startsWith('export ')) {
            violations.push(`${relative(SRC_DIR, indexPath)}: non-export statement: "${trimmed}"`)
            continue
          }

          for (const pattern of LOGIC_PATTERNS) {
            if (pattern.test(trimmed)) {
              violations.push(
                `${relative(SRC_DIR, indexPath)}: logic detected (${pattern}): "${trimmed}"`,
              )
            }
          }
        }
      }

      expect(
        violations,
        `Barrel exports should only contain re-exports, no logic.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_reset_in_useEffect', () => {
    it('should not call reset() inside useEffect in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')

        // Find useEffect blocks and check for reset( inside them
        const useEffectRegex = /useEffect\(\s*\(\)\s*=>\s*\{/g
        let match: RegExpExecArray | null = useEffectRegex.exec(content)

        while (match !== null) {
          const startIndex = match.index + match[0].length
          // Track brace depth to find the end of the useEffect callback
          let depth = 1
          let pos = startIndex

          while (pos < content.length && depth > 0) {
            if (content[pos] === '{') depth++
            if (content[pos] === '}') depth--
            pos++
          }

          const effectBody = content.slice(startIndex, pos - 1)
          if (/\breset\(/.test(effectBody)) {
            const lineNumber = content.slice(0, match.index).split('\n').length
            violations.push(`${relative(SRC_DIR, filePath)}:${lineNumber}`)
          }
          match = useEffectRegex.exec(content)
        }
      }

      expect(
        violations,
        `reset() called inside useEffect. Use the load-then-render pattern instead (see CLAUDE.md 4.4).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_complex_boolean_state', () => {
    it('should not combine boolean state with negation patterns in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.tsx'])
      const violations: string[] = []

      // Patterns that indicate complex boolean state combinations with negation
      const COMPLEX_PATTERNS = [
        /&&\s*!is(?:Error|Pending|Loading|Fetching)/,
        /!is(?:Error|Pending|Loading|Fetching)\s*&&/,
        /is(?:Loading|Pending)\s*&&\s*!is(?:Error|Pending|Loading|Fetching)/,
      ]

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue

          for (const pattern of COMPLEX_PATTERNS) {
            if (pattern.test(line)) {
              violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
              break
            }
          }
        }
      }

      expect(
        violations,
        `Complex boolean state with negation found. Use TanStack Query status checks or derive state explicitly.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('query_key_factory_enforcement', () => {
    it('should use query key factory, not inline arrays (ADR-029)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue

          // Flag inline query key arrays: queryKey: ['...' or queryKey: ["...
          if (/queryKey:\s*\[/.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Inline queryKey arrays found. Use queryKeys factory from @/lib/query-keys instead (ADR-029).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('type_assertion_enforcement', () => {
    it('should use satisfies over as Type assertions (ADR-035)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        // Skip test files — mock objects legitimately need `as` casts
        if (filePath.includes('.test.')) continue

        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const trimmed = line.trimStart()

          // Skip comment lines
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue
          }

          // Skip lines with import aliasing (import { X as Y })
          if (/\bimport\s/.test(line)) continue

          // Check for ' as ' that is NOT an allowed usage
          if (/ as /.test(line)) {
            // Allowed: as const, as unknown, as never, as React.*
            if (/ as const\b/.test(line)) continue
            if (/ as unknown\b/.test(line)) continue
            if (/ as never\b/.test(line)) continue
            if (/ as React\./.test(line)) continue

            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Type assertions with 'as Type' found. Use 'satisfies Type' or fix the actual type (ADR-035).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})
