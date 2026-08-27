import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { containsNoEmbeddedOcrMaterial, parseOcrEvaluationManifest } from '../../tools/ocr-evaluation-manifest.mjs'

const manifestUrl = new URL('../../datasets/ocr/reservation-engineering-v1.json', import.meta.url)
const manifestText = await readFile(manifestUrl, 'utf8')
const editedManifest = (edit) => {
  const manifest = JSON.parse(manifestText)
  edit(manifest)
  return JSON.stringify(manifest)
}

describe('T122 strict synthetic OCR evaluation manifest', () => {
  test('accepts and freezes the versioned structured synthetic manifest', () => {
    const manifest = parseOcrEvaluationManifest(manifestText)
    expect(manifest).toMatchObject({
      version: 'reservation-ocr-synthetic-v1',
      provenance: {
        synthetic: true,
        containsRealParticipantData: false,
        containsProductionImages: false,
        productionRepresentative: false,
      },
    })
    expect(manifest.cases.length).toBeGreaterThan(0)
    expect(manifest.cases.some((fixture) => fixture.injection)).toBe(true)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.cases[0].evidence)).toBe(true)
    expect(containsNoEmbeddedOcrMaterial(manifest)).toBe(true)
  })

  test('rejects unknown manifest and case fields, including out-of-contract image text', () => {
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.productionReleaseAllowed = true
        }),
      ),
    ).toThrow(/unexpected or missing field/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases[0].syntheticImageText = 'separate caller-controlled signal'
        }),
      ),
    ).toThrow(/unexpected or missing field/)
  })

  test('rejects production provenance, URLs, and base64-like material even in allowlisted evidence text', () => {
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.provenance.containsProductionImages = true
        }),
      ),
    ).toThrow(/synthetic and non-production/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases[0].evidence.businessName.value = 'prefix data:image/png;base64,AAAA'
        }),
      ),
    ).toThrow(/URL, binary-like/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases[0].evidence.businessName.value = `prefix-${'A'.repeat(128)}`
        }),
      ),
    ).toThrow(/URL, binary-like/)
  })

  test('rejects non-allowlisted manifest, OCR schema, and expected-reason versions', () => {
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.version = 'reservation-ocr-synthetic-v2'
        }),
      ),
    ).toThrow(/version is not allowlisted/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.structuralPolicy.schemaVersion = 'reservation-image-v2'
        }),
      ),
    ).toThrow(/policy must remain synthetic/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases[0].expectedReasonCode = 'OCR_PROVIDER_AUTHORIZED_STATE_CHANGE'
        }),
      ),
    ).toThrow(/invalid expected result/)
  })

  test('requires real injection coverage and exact forbidden-output probes', () => {
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases = manifest.cases.filter((fixture) => !fixture.injection)
        }),
      ),
    ).toThrow(/at least one injection case/)
    expect(() =>
      parseOcrEvaluationManifest(
        editedManifest((manifest) => {
          manifest.cases.find((fixture) => fixture.injection).attemptedOutputFields.push('unknownProbe')
        }),
      ),
    ).toThrow(/unique allowlisted values/)
  })
})
