import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FEATURES_DIR = join(__dirname, '../../src/features')

/**
 * Architecture tests for feature-first structure.
 *
 * These validate structural rules that eslint-plugin-boundaries cannot enforce:
 * - Every feature directory MUST have an index.ts barrel export
 * - File naming MUST be kebab-case
 *
 * Run with: just test-arch
 */

function getFeatureDirs(): string[] {
  if (!existsSync(FEATURES_DIR)) return []
  return readdirSync(FEATURES_DIR).filter((name) => {
    const fullPath = join(FEATURES_DIR, name)
    return statSync(fullPath).isDirectory()
  })
}

function getAllFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

describe('Feature Structure', () => {
  const features = getFeatureDirs()

  it('should have at least one feature directory', () => {
    expect(features.length).toBeGreaterThan(0)
  })

  describe.each(features)('Feature: %s', (featureName) => {
    const featurePath = join(FEATURES_DIR, featureName)

    it('should have an index.ts barrel export', () => {
      const hasIndex =
        existsSync(join(featurePath, 'index.ts')) || existsSync(join(featurePath, 'index.tsx'))
      expect(hasIndex, `Feature "${featureName}" is missing index.ts barrel export`).toBe(true)
    })

    it('should use kebab-case for directory name', () => {
      expect(featureName).toMatch(KEBAB_CASE_REGEX)
    })
  })
})

describe('File Naming Conventions', () => {
  const features = getFeatureDirs()

  it.each(features)('Feature "%s" files should use kebab-case', (featureName) => {
    const featurePath = join(FEATURES_DIR, featureName)
    const files = getAllFiles(featurePath)

    for (const filePath of files) {
      const fileName = basename(filePath)
      // Strip extension(s) for naming check
      const nameWithoutExt = fileName.replace(/\.(test\.)?(ts|tsx|js|jsx|css)$/, '')
      if (nameWithoutExt === 'index') continue // index files are exempt

      expect(nameWithoutExt, `File "${filePath}" should use kebab-case`).toMatch(KEBAB_CASE_REGEX)
    }
  })
})
