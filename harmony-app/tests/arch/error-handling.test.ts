import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')

/**
 * Architecture tests for error handling patterns (ADR-045).
 *
 * Every useMutation triggered by an explicit user action MUST have error
 * feedback — either an onError callback in the hook itself, or an explicit
 * opt-out comment when error handling is deferred to the call site.
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

describe('Error Handling (ADR-045)', () => {
  describe('mutation_error_handling_enforcement', () => {
    it('every useMutation hook must have onError or an ADR-045 opt-out comment', () => {
      const hookFiles = getAllFiles(FEATURES_DIR, ['.ts']).filter((filePath) => {
        // Only scan hook files, skip test files
        if (filePath.includes('.test.')) return false
        return /\/hooks\/use-[^/]+\.ts$/.test(filePath)
      })

      const violations: string[] = []

      for (const filePath of hookFiles) {
        const content = readFileSync(filePath, 'utf-8')

        // Skip files that do not contain useMutation
        if (!content.includes('useMutation')) continue

        // Check for ADR-045 opt-out at file level
        if (content.includes('// ADR-045: error handled at call site')) continue

        // Check that the useMutation config object contains onError
        // WHY regex over AST: Consistent with every other arch test in this codebase.
        // The pattern is reliable because our mutation hooks follow a uniform structure:
        // useMutation({ mutationFn, onSuccess?, onError? })
        const hasMutationOnError = /useMutation\(\{[\s\S]*?onError[\s\S]*?\}\)/.test(content)

        if (!hasMutationOnError) {
          violations.push(relative(SRC_DIR, filePath))
        }
      }

      expect(
        violations,
        `useMutation hooks missing onError handler (ADR-045). Either add onError or annotate with "// ADR-045: error handled at call site".\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})
