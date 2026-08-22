// Enforce the SPEC.md §3.1 capability map on real import paths.
//
// WHY A CUSTOM RULE RATHER THAN no-restricted-imports.
// That rule matches the import SPECIFIER STRING with minimatch, not the resolved path. A relative
// deep import — './modules/guideline-delivery/reason-codes.js', or '../workflow-core/transition.js'
// from inside another module — never matches a '**/modules/*/!(index)*' pattern, so the boundary it
// appears to enforce is not enforced at all. Resolving the path first is the whole point, and it is
// also what lets the message name BOTH modules, which T6 requires.
//
// TWO RULES, ONE PASS:
//   1. A module's public surface is its index. Reaching past it couples a consumer to internals
//      that SPEC.md §5 says are free to be reorganized (T8's Zod config, T9's Drizzle connection).
//   2. A cross-module import must be declared in module-graph.json. Undeclared reach is how a
//      layered map quietly becomes a ball of mud.

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

const GRAPH_PATH = resolvePath(import.meta.dirname, '..', '..', 'module-graph.json')

/** @type {{ modules: Record<string, { dependsOn: string[] }> }} */
const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'))

/**
 * SPEC.md §3.1 asserts the graph is acyclic. Nothing else in the toolchain checks that, so it is
 * checked here — at load, because a cyclic map is a configuration error, not a code error, and
 * reporting it against some arbitrary import would point at the wrong thing.
 */
const assertAcyclic = () => {
  const VISITING = 1
  const DONE = 2
  const state = new Map()

  const walk = (id, trail) => {
    if (state.get(id) === DONE) return
    if (state.get(id) === VISITING) {
      throw new Error(
        `module-graph.json contains a dependency cycle: ${[...trail, id].join(' -> ')}. ` +
          'SPEC.md §3.1 requires an acyclic graph; if two modules each need the other, they are one module.',
      )
    }
    state.set(id, VISITING)
    for (const next of graph.modules[id]?.dependsOn ?? []) {
      if (graph.modules[next] !== undefined) walk(next, [...trail, id])
    }
    state.set(id, DONE)
  }

  for (const id of Object.keys(graph.modules)) walk(id, [])
}

assertAcyclic()

/**
 * Which module a path belongs to, and what it reaches inside that module.
 *
 * Returns undefined for anything outside a modules/ directory — the composition root, the shared
 * packages, tests and tooling all live there and are governed by rule 1 only.
 */
const locate = (absolutePath) => {
  const parts = absolutePath.split(/[\\/]/)
  const index = parts.lastIndexOf('modules')
  if (index === -1 || index + 1 >= parts.length) return undefined

  const id = parts[index + 1]
  if (id === undefined || graph.modules[id] === undefined) return undefined

  return { id, inside: parts.slice(index + 2) }
}

/** The public surface is the module directory itself, or its index file. */
const isPublicSurface = (inside) =>
  inside.length === 0 || (inside.length === 1 && /^index\.(?:js|ts|mjs|cjs|mts|cts)$/.test(inside[0] ?? ''))

/** @type {import('eslint').Rule.RuleModule} */
export const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce the SPEC.md §3.1 capability map: public surfaces and declared dependencies.',
    },
    schema: [],
    messages: {
      deepImport:
        'Reaching past the public surface of "{{target}}". Import from "{{target}}" itself — SPEC.md §5 makes index.ts its only public surface, so everything else is free to be reorganized.',
      undeclared:
        'Module "{{source}}" may not import "{{target}}". That edge is not in module-graph.json, which encodes the SPEC.md §3.1 capability map. Add it there deliberately, or move the code.',
    },
  },

  create(context) {
    const filename = context.filename
    // Only relative specifiers can reach into a module; a bare specifier is a package.
    const isRelative = (specifier) => specifier.startsWith('.')

    const check = (node, specifier) => {
      if (typeof specifier !== 'string' || !isRelative(specifier)) return

      const target = locate(resolvePath(dirname(filename), specifier))
      if (target === undefined) return

      const source = locate(filename)
      // Inside its own module, a file may import anything it likes.
      if (source?.id === target.id) return

      if (!isPublicSurface(target.inside)) {
        context.report({ node, messageId: 'deepImport', data: { target: target.id } })
        return
      }

      // A file outside every module — the composition root, a test — may import any public surface.
      // Only module-to-module edges are governed by the graph.
      if (source === undefined) return

      const allowed = graph.modules[source.id]?.dependsOn ?? []
      if (!allowed.includes(target.id)) {
        context.report({ node, messageId: 'undeclared', data: { source: source.id, target: target.id } })
      }
    }

    return {
      ImportDeclaration: (node) => {
        check(node.source, node.source.value)
      },
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source, node.source.value)
      },
      ExportAllDeclaration: (node) => {
        check(node.source, node.source.value)
      },
      // `await import('../other-module/internals.js')` evades a static-import-only rule otherwise.
      ImportExpression: (node) => {
        if (node.source.type === 'Literal') check(node.source, node.source.value)
      },
    }
  },
}

export const moduleGraph = graph
