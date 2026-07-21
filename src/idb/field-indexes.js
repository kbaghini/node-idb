// @ts-check

const manualSerializationVersion = 1
const autoSerializationVersion = 2

const autoPresets = Object.freeze({
  conservative: Object.freeze({
    maxIndexesPerCollection: 12,
    minDocuments: 5_000,
    minQueryCount: 20,
    slowQueryMs: 25,
    maxResultRatio: 0.1,
    evaluationInterval: 20,
    cooldownMs: 300_000,
    allowDrop: false,
    dropUnusedAfterMs: 30 * 24 * 60 * 60 * 1_000,
    minIndexAgeMs: 7 * 24 * 60 * 60 * 1_000,
  }),
  balanced: Object.freeze({
    maxIndexesPerCollection: 24,
    minDocuments: 500,
    minQueryCount: 8,
    slowQueryMs: 10,
    maxResultRatio: 0.25,
    evaluationInterval: 8,
    cooldownMs: 60_000,
    allowDrop: false,
    dropUnusedAfterMs: 14 * 24 * 60 * 60 * 1_000,
    minIndexAgeMs: 24 * 60 * 60 * 1_000,
  }),
  aggressive: Object.freeze({
    maxIndexesPerCollection: 32,
    minDocuments: 100,
    minQueryCount: 3,
    slowQueryMs: 2,
    maxResultRatio: 0.5,
    evaluationInterval: 3,
    cooldownMs: 10_000,
    allowDrop: true,
    dropUnusedAfterMs: 7 * 24 * 60 * 60 * 1_000,
    minIndexAgeMs: 60 * 60 * 1_000,
  }),
})

/**
 * @typedef {'all' | 'none'} FieldIndexDefault
 * @typedef {{ collection: string, kind: 'path' | 'pattern', value: string, enabled: boolean }} NormalizedFieldIndexRule
 * @typedef {{
 *   version: number,
 *   mode: 'manual' | 'auto',
 *   default: FieldIndexDefault,
 *   rules: readonly Readonly<NormalizedFieldIndexRule>[],
 *   serialized: string,
 *   auto: null | Readonly<Record<string, any>>,
 *   isIndexed(collection: string, fieldPath: string): boolean,
 *   decision(collection: string, fieldPath: string): 'enabled' | 'disabled' | 'auto',
 * }} NormalizedFieldIndexes
 */

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} label */
function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`Unknown ${label} option: ${unknown.join(', ')}`)
}

/** @param {unknown} value */
function normalizeCollection(value) {
  if (value === '*') return '*'
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError('fieldIndexes rule collection must be a non-empty string')
  }
  if (value.includes('\0')) {
    throw new TypeError('fieldIndexes rule collection must not contain null bytes')
  }
  if (
    !/^(?=.{1,128}$)(?=.*[A-Za-z0-9_])[A-Za-z0-9_-]+$/.test(value) ||
    value === '.' || value === '..'
  ) {
    throw new Error(
      'fieldIndexes rule collection may contain only letters, numbers, underscores and hyphens, or be "*"',
    )
  }
  return value.toLowerCase()
}

/** @param {unknown} value @param {'path' | 'pattern'} kind */
function normalizeFieldSelector(value, kind) {
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError(`fieldIndexes rule ${kind} must be a non-empty string`)
  }
  if (value.includes('\0')) {
    throw new TypeError(`fieldIndexes rule ${kind} must not contain null bytes`)
  }
  if (value.split('.').some((segment) => !segment.length)) {
    throw new Error(`fieldIndexes rule ${kind} must not contain empty path segments`)
  }
  return value
}

/**
 * Segment glob matching deliberately recognizes only a complete `*` or `**`
 * segment. Characters such as `?`, `[`, and an embedded `*` remain literal,
 * which keeps matching independent of the operating system and regular
 * expression rules.
 *
 * @param {string} pattern
 * @param {string} fieldPath
 */
function matchesPattern(pattern, fieldPath) {
  if (!fieldPath) return false
  const patternSegments = pattern.split('.')
  const pathSegments = fieldPath.split('.')
  /** @type {Map<string, boolean>} */
  const memo = new Map()

  /** @param {number} patternIndex @param {number} pathIndex */
  function visit(patternIndex, pathIndex) {
    const key = `${patternIndex}:${pathIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    let matched
    if (patternIndex === patternSegments.length) {
      matched = pathIndex === pathSegments.length
    } else if (patternSegments[patternIndex] === '**') {
      matched = visit(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && visit(patternIndex, pathIndex + 1))
    } else {
      matched = pathIndex < pathSegments.length &&
        (patternSegments[patternIndex] === '*' ||
          patternSegments[patternIndex] === pathSegments[pathIndex]) &&
        visit(patternIndex + 1, pathIndex + 1)
    }
    memo.set(key, matched)
    return matched
  }

  return visit(0, 0)
}

/**
 * @param {FieldIndexDefault} defaultMode
 * @param {NormalizedFieldIndexRule[]} sourceRules
 * @returns {NormalizedFieldIndexes}
 */
function createNormalizedPolicy(defaultMode, sourceRules) {
  const rules = Object.freeze(sourceRules.map((rule) => Object.freeze({ ...rule })))
  const serializable = {
    version: manualSerializationVersion,
    default: defaultMode,
    rules: rules.map(({ collection, kind, value, enabled }) => ({
      collection,
      kind,
      value,
      enabled,
    })),
  }
  const serialized = JSON.stringify(serializable)

  /** @param {string} collection @param {string} fieldPath */
  function isIndexed(collection, fieldPath) {
    const normalizedCollection = normalizeCollection(collection)
    if (normalizedCollection === '*') {
      throw new Error('A concrete collection name is required when matching fieldIndexes')
    }
    if (typeof fieldPath !== 'string' || fieldPath.includes('\0')) {
      throw new TypeError('field path must be a string without null bytes')
    }

    let enabled = defaultMode === 'all'
    // The root storage row has an empty internal path. It follows the default
    // and is intentionally not addressable by document-field rules.
    if (!fieldPath) return enabled

    for (const rule of rules) {
      if (rule.collection !== '*' && rule.collection !== normalizedCollection) continue
      const matched = rule.kind === 'path'
        ? rule.value === fieldPath
        : matchesPattern(rule.value, fieldPath)
      if (matched) enabled = rule.enabled
    }
    return enabled
  }

  return Object.freeze({
    version: manualSerializationVersion,
    mode: 'manual',
    default: defaultMode,
    rules,
    serialized,
    auto: null,
    isIndexed,
    decision(collection, fieldPath) {
      return isIndexed(collection, fieldPath) ? 'enabled' : 'disabled'
    },
  })
}

/** @param {unknown} value @param {string} label @param {number} minimum @param {number} maximum */
function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** @param {unknown} value @param {string} label */
function nonNegativeDuration(value, label) {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER)
}

/** @param {Record<string, unknown>} source */
function createAutoPolicy(source) {
  assertKnownKeys(source, [
    'mode',
    'preset',
    'maxIndexesPerCollection',
    'minDocuments',
    'minQueryCount',
    'slowQueryMs',
    'maxResultRatio',
    'evaluationInterval',
    'cooldownMs',
    'allowDrop',
    'dropUnusedAfterMs',
    'minIndexAgeMs',
    'rules',
  ], 'automatic fieldIndexes')
  if (source.mode !== undefined && source.mode !== 'auto') {
    throw new TypeError('fieldIndexes.mode must be "auto"')
  }
  const preset = source.preset === undefined ? 'balanced' : source.preset
  if (!Object.hasOwn(autoPresets, /** @type {PropertyKey} */ (preset))) {
    throw new TypeError('fieldIndexes.preset must be "conservative", "balanced", or "aggressive"')
  }
  const defaults = autoPresets[/** @type {keyof typeof autoPresets} */ (preset)]
  const manualRules = normalizeFieldIndexes({ default: 'none', rules: source.rules || [] })
  const auto = Object.freeze({
    preset,
    maxIndexesPerCollection: boundedInteger(
      source.maxIndexesPerCollection ?? defaults.maxIndexesPerCollection,
      'fieldIndexes.maxIndexesPerCollection', 1, 1_000,
    ),
    minDocuments: boundedInteger(
      source.minDocuments ?? defaults.minDocuments,
      'fieldIndexes.minDocuments', 0, Number.MAX_SAFE_INTEGER,
    ),
    minQueryCount: boundedInteger(
      source.minQueryCount ?? defaults.minQueryCount,
      'fieldIndexes.minQueryCount', 1, Number.MAX_SAFE_INTEGER,
    ),
    slowQueryMs: nonNegativeDuration(
      source.slowQueryMs ?? defaults.slowQueryMs,
      'fieldIndexes.slowQueryMs',
    ),
    maxResultRatio: source.maxResultRatio ?? defaults.maxResultRatio,
    evaluationInterval: boundedInteger(
      source.evaluationInterval ?? defaults.evaluationInterval,
      'fieldIndexes.evaluationInterval', 1, Number.MAX_SAFE_INTEGER,
    ),
    cooldownMs: nonNegativeDuration(
      source.cooldownMs ?? defaults.cooldownMs,
      'fieldIndexes.cooldownMs',
    ),
    allowDrop: source.allowDrop ?? defaults.allowDrop,
    dropUnusedAfterMs: nonNegativeDuration(
      source.dropUnusedAfterMs ?? defaults.dropUnusedAfterMs,
      'fieldIndexes.dropUnusedAfterMs',
    ),
    minIndexAgeMs: nonNegativeDuration(
      source.minIndexAgeMs ?? defaults.minIndexAgeMs,
      'fieldIndexes.minIndexAgeMs',
    ),
  })
  if (
    typeof auto.maxResultRatio !== 'number' ||
    !Number.isFinite(auto.maxResultRatio) ||
    auto.maxResultRatio < 0 || auto.maxResultRatio > 1
  ) {
    throw new RangeError('fieldIndexes.maxResultRatio must be a number from 0 through 1')
  }
  if (typeof auto.allowDrop !== 'boolean') {
    throw new TypeError('fieldIndexes.allowDrop must be a boolean')
  }

  const serializable = {
    version: autoSerializationVersion,
    mode: 'auto',
    ...auto,
    rules: manualRules.rules.map(({ collection, kind, value, enabled }) => ({
      collection,
      kind,
      value,
      enabled,
    })),
  }
  const serialized = JSON.stringify(serializable)

  function decision(collection, fieldPath) {
    const normalizedCollection = normalizeCollection(collection)
    if (normalizedCollection === '*') {
      throw new Error('A concrete collection name is required when matching fieldIndexes')
    }
    if (typeof fieldPath !== 'string' || fieldPath.includes('\0')) {
      throw new TypeError('field path must be a string without null bytes')
    }
    let result = 'auto'
    if (!fieldPath) return result
    for (const rule of manualRules.rules) {
      if (rule.collection !== '*' && rule.collection !== normalizedCollection) continue
      const matched = rule.kind === 'path'
        ? rule.value === fieldPath
        : matchesPattern(rule.value, fieldPath)
      if (matched) result = rule.enabled ? 'enabled' : 'disabled'
    }
    return result
  }

  return Object.freeze({
    version: autoSerializationVersion,
    mode: 'auto',
    default: 'none',
    rules: manualRules.rules,
    serialized,
    auto,
    decision,
    isIndexed(collection, fieldPath) {
      return decision(collection, fieldPath) === 'enabled'
    },
  })
}

/**
 * Normalizes and snapshots the public field-index policy. Rules are evaluated
 * in order and the last matching rule wins. Collection identity is
 * case-insensitive; document paths remain case-sensitive.
 *
 * @param {unknown} [value]
 * @returns {NormalizedFieldIndexes}
 */
export function normalizeFieldIndexes(value = 'auto') {
  if (value === 'auto') return createAutoPolicy({ mode: 'auto' })
  if (value === 'all' || value === 'none') return createNormalizedPolicy(value, [])
  if (!isPlainObject(value)) {
    throw new TypeError('fieldIndexes must be "auto", "all", "none", or a policy object')
  }

  const policy = /** @type {Record<string, unknown>} */ (value)
  if (policy.mode === 'auto') return createAutoPolicy(policy)
  assertKnownKeys(policy, ['default', 'rules'], 'fieldIndexes')
  const defaultMode = policy.default === undefined ? 'all' : policy.default
  if (defaultMode !== 'all' && defaultMode !== 'none') {
    throw new TypeError('fieldIndexes.default must be either "all" or "none"')
  }
  const sourceRules = policy.rules === undefined ? [] : policy.rules
  if (!Array.isArray(sourceRules)) throw new TypeError('fieldIndexes.rules must be an array')

  /** @type {NormalizedFieldIndexRule[]} */
  const rules = sourceRules.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new TypeError(`fieldIndexes.rules[${index}] must be an object`)
    }
    const rule = /** @type {Record<string, unknown>} */ (source)
    assertKnownKeys(rule, ['collection', 'path', 'pattern', 'enabled'], `fieldIndexes.rules[${index}]`)
    const hasPath = Object.hasOwn(rule, 'path')
    const hasPattern = Object.hasOwn(rule, 'pattern')
    if (hasPath === hasPattern) {
      throw new TypeError(
        `fieldIndexes.rules[${index}] must provide exactly one of path or pattern`,
      )
    }
    if (typeof rule.enabled !== 'boolean') {
      throw new TypeError(`fieldIndexes.rules[${index}].enabled must be a boolean`)
    }
    const kind = hasPath ? 'path' : 'pattern'
    return {
      collection: normalizeCollection(rule.collection),
      kind,
      value: normalizeFieldSelector(rule[kind], kind),
      enabled: rule.enabled,
    }
  })

  return createNormalizedPolicy(defaultMode, rules)
}

/**
 * Restores the canonical persisted representation produced by
 * `normalizeFieldIndexes().serialized`.
 *
 * @param {unknown} serialized
 * @returns {NormalizedFieldIndexes}
 */
export function deserializeFieldIndexes(serialized) {
  if (typeof serialized !== 'string' || !serialized.length) {
    throw new TypeError('serialized fieldIndexes policy must be a non-empty string')
  }
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new TypeError('serialized fieldIndexes policy must contain valid JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError('serialized fieldIndexes policy must contain an object')
  }
  const stored = /** @type {Record<string, unknown>} */ (parsed)
  if (stored.version === autoSerializationVersion && stored.mode === 'auto') {
    assertKnownKeys(stored, [
      'version', 'mode', 'preset', 'maxIndexesPerCollection', 'minDocuments',
      'minQueryCount', 'slowQueryMs', 'maxResultRatio', 'evaluationInterval',
      'cooldownMs', 'allowDrop', 'dropUnusedAfterMs', 'minIndexAgeMs', 'rules',
    ], 'serialized automatic fieldIndexes')
    if (stored.mode !== 'auto' || !Array.isArray(stored.rules)) {
      throw new TypeError('serialized automatic fieldIndexes policy is invalid')
    }
    const rules = stored.rules.map((source, index) => {
      if (!isPlainObject(source)) {
        throw new TypeError(`serialized fieldIndexes rule ${index} must be an object`)
      }
      const rule = /** @type {Record<string, unknown>} */ (source)
      assertKnownKeys(rule, ['collection', 'kind', 'value', 'enabled'], `serialized fieldIndexes rule ${index}`)
      if (rule.kind !== 'path' && rule.kind !== 'pattern') {
        throw new TypeError(`serialized fieldIndexes rule ${index} has an invalid kind`)
      }
      return {
        collection: rule.collection,
        [rule.kind]: rule.value,
        enabled: rule.enabled,
      }
    })
    return normalizeFieldIndexes({
      mode: 'auto',
      preset: stored.preset,
      maxIndexesPerCollection: stored.maxIndexesPerCollection,
      minDocuments: stored.minDocuments,
      minQueryCount: stored.minQueryCount,
      slowQueryMs: stored.slowQueryMs,
      maxResultRatio: stored.maxResultRatio,
      evaluationInterval: stored.evaluationInterval,
      cooldownMs: stored.cooldownMs,
      allowDrop: stored.allowDrop,
      dropUnusedAfterMs: stored.dropUnusedAfterMs,
      minIndexAgeMs: stored.minIndexAgeMs,
      rules,
    })
  }
  assertKnownKeys(stored, ['version', 'default', 'rules'], 'serialized fieldIndexes')
  if (stored.version !== manualSerializationVersion) {
    throw new Error(`Unsupported serialized fieldIndexes policy version: ${String(stored.version)}`)
  }
  if (!Array.isArray(stored.rules)) {
    throw new TypeError('serialized fieldIndexes policy rules must be an array')
  }

  const rules = stored.rules.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new TypeError(`serialized fieldIndexes rule ${index} must be an object`)
    }
    const rule = /** @type {Record<string, unknown>} */ (source)
    assertKnownKeys(
      rule,
      ['collection', 'kind', 'value', 'enabled'],
      `serialized fieldIndexes rule ${index}`,
    )
    if (rule.kind !== 'path' && rule.kind !== 'pattern') {
      throw new TypeError(`serialized fieldIndexes rule ${index} has an invalid kind`)
    }
    return {
      collection: rule.collection,
      [rule.kind]: rule.value,
      enabled: rule.enabled,
    }
  })

  return normalizeFieldIndexes({ default: stored.default, rules })
}
