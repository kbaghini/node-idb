// @ts-check

import sqliteParser from 'sqlite-parser'

import { ValueType, decodeValue, deepClone } from './codec.js'
import { indexedValueExpression, valueTable } from './collection.js'
import { quoteIdentifier } from './database.js'

const directWildcard = '__idb_direct_wildcard__'
const namedParameterPrefix = '__idb_named_parameter_'

const binaryOperations = new Set([
  '+', '-', '*', '/', '%', '=', '==', '!=', '<>', '<', '<=', '>', '>=',
  'and', 'or', 'like', 'not like', 'glob', 'not glob', 'match', 'not match',
  'regexp', 'not regexp', 'is', 'is not', 'in',
  'not in', 'between', 'not between', '||', '&', '|', '<<', '>>',
])
const aggregateFunctions = new Set(['avg', 'count', 'group_concat', 'max', 'min', 'sum', 'total'])
const indexedOperations = new Set([
  '=', '==', '!=', '<>', '<', '<=', '>', '>=',
  'like', 'not like', 'glob', 'not glob',
  'in', 'not in', 'between', 'not between',
])

/** @param {string} value */
function unquote(value) {
  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Protects the custom direct-child wildcard and named parameters while
 * leaving operators, string literals, and normal dotted SQL identifiers intact.
 * @param {string} sql
 */
function preprocess(sql) {
  let result = ''
  let quote = ''
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]
    if (quote) {
      result += character
      if (quote === ']' ? character === ']' : character === quote) {
        if (sql[index + 1] === character && quote !== ']') result += sql[++index]
        else quote = ''
      } else if (character === '\\' && quote !== ']') {
        if (index + 1 < sql.length) result += sql[++index]
      }
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
      result += character
      continue
    }
    if (character === '.' && sql[index + 1] === '?') {
      result += `.${directWildcard}`
      index++
      continue
    }
    if (character === '$' && /[A-Za-z_]/.test(sql[index + 1] || '')) {
      let end = index + 2
      while (/[A-Za-z0-9_]/.test(sql[end] || '')) end++
      result += `${namedParameterPrefix}${sql.slice(index + 1, end)}`
      index = end - 1
      continue
    }
    result += character
  }
  return result
}

/**
 * @param {string} sql
 * @returns {Promise<any>}
 */
export function parseSql(sql) {
  return new Promise((resolve, reject) => {
    sqliteParser(preprocess(sql), (error, ast) => {
      if (error) reject(error)
      else if (!ast?.statement?.length) reject(new Error('SQL statement is empty'))
      else resolve(ast.statement[0])
    })
  })
}

/**
 * sqlite-parser does not retain the case of unquoted aliases. Capture SELECT
 * aliases from the source so explicit output names remain exact.
 * @param {string} sql
 */
function sourceResultAliases(sql) {
  const selectMatch = /\bselect\b/i.exec(sql)
  if (!selectMatch) return []
  let quote = ''
  let depth = 0
  let fromIndex = -1
  const start = selectMatch.index + selectMatch[0].length
  for (let index = start; index < sql.length; index++) {
    const character = sql[index]
    if (quote) {
      if (quote === ']' ? character === ']' : character === quote) quote = ''
      else if (character === '\\') index++
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
    } else if (character === '(') depth++
    else if (character === ')') depth--
    else if (
      depth === 0 &&
      /^from\b/i.test(sql.slice(index)) &&
      /\s/.test(sql[index - 1] || ' ')
    ) {
      fromIndex = index
      break
    }
  }
  if (fromIndex < 0) return []

  const items = []
  let itemStart = 0
  quote = ''
  depth = 0
  const source = sql.slice(start, fromIndex)
  for (let index = 0; index <= source.length; index++) {
    const character = source[index]
    if (quote) {
      if (quote === ']' ? character === ']' : character === quote) quote = ''
      else if (character === '\\') index++
    } else if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character
    } else if (character === '(') depth++
    else if (character === ')') depth--
    else if ((character === ',' && depth === 0) || index === source.length) {
      items.push(source.slice(itemStart, index).trim())
      itemStart = index + 1
    }
  }
  return items.map((/** @type {string} */ item) => {
    const match = /\s+as\s+(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$-]*)\s*$/i.exec(item)
    return match ? unquote(match[1]) : undefined
  })
}

/** @param {any} root */
function annotateParameters(root) {
  /** @type {WeakMap<object, number>} */
  const positions = new WeakMap()
  let index = 0
  const visit = (/** @type {any} */ value) => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'variable' && value.format === 'numbered' && value.name === '?') {
      positions.set(value, index++)
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(root)
  return positions
}

class Bindings {
  /** @param {unknown} parameters @param {WeakMap<object, number>} positions */
  constructor(parameters, positions) {
    this.parameters = parameters
    this.positions = positions
    /** @type {unknown[]} */
    this.values = []
  }

  /** @param {any} node */
  resolve(node) {
    let value
    if (node.type === 'variable') {
      const index = this.positions.get(node) || 0
      value = Array.isArray(this.parameters)
        ? this.parameters[index]
        : index === 0 && !this.parameters
          ? undefined
          : this.parameters
    } else {
      const name = String(node.name).slice(namedParameterPrefix.length)
      const source = this.parameters && typeof this.parameters === 'object'
        ? /** @type {Record<string, unknown>} */ (this.parameters)
        : {}
      value = Object.hasOwn(source, `$${name}`) ? source[`$${name}`] : source[name]
    }
    return value
  }

  /** @param {any} node */
  bind(node) {
    let value = this.resolve(node)
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('SQL numeric parameters must be finite')
    }
    if (value instanceof Date) value = value.getTime()
    if (typeof value === 'bigint') value = value.toString()
    if (value !== null && value !== undefined &&
        !['string', 'number', 'boolean'].includes(typeof value) && !Buffer.isBuffer(value)) {
      throw new TypeError('Unsupported SQL parameter type')
    }
    this.values.push(value ?? null)
    return `?${this.values.length}`
  }
}

/**
 * @param {import('./collection.js').CollectionStore} store
 * @param {any} statement
 * @param {unknown} parameters
 */
function createContext(store, statement, parameters) {
  return {
    store,
    statement,
    tableAliases: new Set([
      store.collection.toLowerCase(),
      String(statement.from?.alias || statement.into?.alias || '').toLowerCase(),
    ].filter(Boolean)),
    required: new Map(),
    resultAliases: new Set(),
    bindings: new Bindings(parameters, annotateParameters(statement)),
  }
}

/**
 * Removes an optional collection/table qualifier while preserving nested paths.
 * @param {ReturnType<typeof createContext>} context
 * @param {string} rawName
 */
function normalizedReference(context, rawName) {
  let name = unquote(rawName).replaceAll(`.${directWildcard}`, '.?')
  const parts = name.split('.')
  if (parts.length > 1 && context.tableAliases.has(parts[0].toLowerCase())) {
    parts.shift()
    name = parts.join('.')
  }
  return name
}

/**
 * @param {ReturnType<typeof createContext>} context
 * @param {string} rawName
 */
export function resolveFields(context, rawName) {
  const name = normalizedReference(context, rawName)
  if (name === 'object_id') return []
  const fields = context.store.fields.filter((field) => field.parent_field_id !== null)

  if (name === '*' || name === '?') {
    return name === '?' ? fields.filter((field) => field.level === 1) : fields
  }
  if (name.endsWith('.*') || name.endsWith('.?')) {
    const recursive = name.endsWith('.*')
    const base = name.slice(0, -2)
    const parent = fields.find((field) => field.path === base) ||
      fields.find((field) => field.path.toLowerCase() === base.toLowerCase())
    if (!parent) return []
    return fields.filter((field) => recursive
      ? field.path.startsWith(`${parent.path}.`)
      : field.parent_field_id === parent.id)
  }

  const exact = fields.filter((field) => field.path === name)
  if (exact.length) return exact
  const insensitive = fields.filter((field) => field.path.toLowerCase() === name.toLowerCase())
  if (insensitive.length) return insensitive
  if (!name.includes('.')) {
    return fields.filter((field) => field.name.toLowerCase() === name.toLowerCase())
  }
  return []
}

/** @param {ReturnType<typeof createContext>} context @param {import('./collection.js').Field} field */
function fieldReference(context, field) {
  context.required.set(field.id, field)
  return quoteIdentifier(`__f_${field.id}`)
}

/** @param {ReturnType<typeof createContext>} context @param {import('./collection.js').Field} field */
function defaultFieldAlias(context, field) {
  const duplicates = context.store.fields.filter(
    (candidate) => candidate.parent_field_id !== null &&
      candidate.name.toLowerCase() === field.name.toLowerCase(),
  )
  return duplicates.length > 1 ? field.path : field.name
}

/** @param {any} node */
function functionName(node) {
  return String(node?.name?.name || node?.name || '').toLowerCase()
}

/** @param {any} node @returns {boolean} */
function hasAggregate(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'function' && aggregateFunctions.has(functionName(node))) return true
  return Object.values(node).some((/** @type {any} */ entry) => hasAggregate(entry))
}

/**
 * A lone bare or real table-qualified star is the document projection. Stored
 * path wildcards such as profile.* remain flat field projections.
 * @param {any} statement
 * @param {ReturnType<typeof createContext>} context
 */
function isDocumentProjection(statement, context) {
  if (statement.result?.length !== 1) return false
  const result = statement.result[0]
  return result?.type === 'identifier' && result.variant === 'star' &&
    normalizedReference(context, String(result.name)) === '*'
}

/** @param {any} node */
function isStaticValue(node) {
  if (!node) return false
  if (node.type === 'literal' || node.type === 'variable') return true
  if (node.type === 'identifier') {
    const name = String(node.name)
    return name.startsWith(namedParameterPrefix) || /^(true|false)$/i.test(name)
  }
  if (node.type === 'expression' && node.variant === 'list') {
    return node.expression.every(isStaticValue)
  }
  return false
}

/**
 * Uses the per-field expression index for common scalar predicates, while the
 * second branch retains exact legacy behavior for long text, arrays and binary
 * values stored in the attached blob database.
 * @param {import('./collection.js').Field} field
 * @param {any} node
 * @param {ReturnType<typeof createContext>} context
 * @param {{ allowResultAlias?: boolean, allowIndexedPredicate?: boolean }} options
 */
function renderIndexedPredicate(field, node, context, options) {
  const operation = String(node.operation).toUpperCase()
  const table = valueTable(field.id)

  /** @type {(value: string) => string} */
  let comparison
  if (node.operation.includes('between')) {
    const lower = render(node.right.left, context, options)
    const upper = render(node.right.right, context, options)
    comparison = (value) => `${value} ${operation} ${lower} AND ${upper}`
  } else if (node.operation.includes('in')) {
    const list = render(node.right, context, options)
    comparison = (value) => `${value} ${operation} (${list})`
  } else {
    const right = render(node.right, context, options)
    const escape = node.escape
      ? ` ESCAPE ${render(node.escape, context, options)}`
      : ''
    comparison = (value) => `${value} ${operation} ${right}${escape}`
  }

  return `${quoteIdentifier('object_id')} IN (
    SELECT v.object_id FROM ${table} v
      WHERE ${comparison(indexedValueExpression('v'))}
    UNION ALL
    SELECT v.object_id FROM ${table} v
      JOIN blobs.tbl_blobs b ON b.id=v.id
      WHERE v.type IN (${ValueType.text}, ${ValueType.array}, ${ValueType.binary})
        AND ${comparison('b.blob')}
  )`
}

/**
 * @param {any} node
 * @param {ReturnType<typeof createContext>} context
 * @param {{ allowResultAlias?: boolean, allowIndexedPredicate?: boolean }} [options]
 * @returns {string}
 */
function render(node, context, options = {}) {
  if (!node) return ''
  if (Array.isArray(node)) return node.map((entry) => render(entry, context, options)).join(', ')
  if (node.type === 'identifier') {
    if (node.variant === 'function') {
      const name = String(node.name)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL function: ${name}`)
      return name.toUpperCase()
    }
    if (node.variant === 'star') return '*'
    const name = String(node.name)
    if (name.startsWith(namedParameterPrefix)) return context.bindings.bind(node)
    if (/^(true|false)$/i.test(name)) return name.toLowerCase() === 'true' ? '1' : '0'
    if (normalizedReference(context, name).toLowerCase() === 'object_id') {
      return quoteIdentifier('object_id')
    }
    const fields = resolveFields(context, name)
    if (fields.length === 1) return fieldReference(context, fields[0])
    if (fields.length > 1) throw new Error(`Ambiguous field "${unquote(name)}"; use an exact path`)
    if (options.allowResultAlias && context.resultAliases.has(name.toLowerCase())) {
      return quoteIdentifier(name)
    }
    return 'NULL'
  }
  if (node.type === 'variable') return context.bindings.bind(node)
  if (node.type === 'literal') {
    if (node.variant === 'decimal') return String(Number(node.value))
    if (node.variant === 'text') {
      context.bindings.values.push(String(node.value))
      return `?${context.bindings.values.length}`
    }
    if (node.variant === 'null') return 'NULL'
  }
  if (node.type === 'function') {
    const name = render(node.name, context)
    const distinct = node.distinct || node.args?.filter === 'distinct'
    return `${name}(${distinct ? 'DISTINCT ' : ''}${render(node.args, context, {
      ...options,
      allowIndexedPredicate: false,
    })})`
  }
  if (node.type === 'expression') {
    if (node.variant === 'list') {
      return node.expression.map((/** @type {any} */ entry) => render(entry, context, options)).join(', ')
    }
    if (node.variant === 'order') {
      const direction = String(node.direction || '').toUpperCase()
      if (direction && direction !== 'ASC' && direction !== 'DESC') throw new Error('Invalid sort direction')
      return `${render(node.expression, context, { allowResultAlias: true })}${direction ? ` ${direction}` : ''}`
    }
    if (node.variant === 'limit') {
      return `${render(node.start, context)}${node.offset ? ` OFFSET ${render(node.offset, context)}` : ''}`
    }
    if (node.variant === 'case') {
      const caseOptions = { ...options, allowIndexedPredicate: false }
      const discriminant = node.discriminant
        ? `${render(node.discriminant, context, caseOptions)} `
        : ''
      return `CASE ${discriminant}${node.expression.map((/** @type {any} */ entry) => render(entry, context, caseOptions)).join(' ')} END`
    }
    if (node.variant === 'operation') {
      if (node.format === 'unary') {
        const operator = String(node.operator || '').toUpperCase()
        if (!['NOT', '+', '-', '~'].includes(operator)) throw new Error(`Unsupported unary operator: ${operator}`)
        return `(${operator} ${render(node.expression, context, {
          ...options,
          allowIndexedPredicate: false,
        })})`
      }
      const operation = String(node.operation || '').toLowerCase()
      if (!binaryOperations.has(operation)) throw new Error(`Unsupported SQL operator: ${operation}`)
      const childOptions = operation === 'and' || operation === 'or'
        ? options
        : { ...options, allowIndexedPredicate: false }
      const leftFields = node.left?.type === 'identifier'
        ? resolveFields(context, String(node.left.name))
        : []
      const staticRight = operation.includes('between')
        ? isStaticValue(node.right?.left) && isStaticValue(node.right?.right)
        : isStaticValue(node.right)
      if (
        options.allowIndexedPredicate && leftFields.length &&
        indexedOperations.has(operation) && staticRight &&
        (!node.escape || isStaticValue(node.escape))
      ) {
        const separator = operation.startsWith('not') || operation === '!=' || operation === '<>'
          ? ' AND '
          : ' OR '
        return `(${leftFields
          .map((field) => renderIndexedPredicate(field, node, context, childOptions))
          .join(separator)})`
      }
      if (leftFields.length > 1 && ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'like', 'glob', 'is', 'is not', 'in', 'not in', 'between', 'not between'].includes(operation)) {
        return `(${leftFields.map((field) => {
          const left = fieldReference(context, field)
          if (operation.includes('between')) {
            return `${left} ${operation.toUpperCase()} ${render(node.right.left, context, childOptions)} AND ${render(node.right.right, context, childOptions)}`
          }
          if (operation.includes('in')) return `${left} ${operation.toUpperCase()} (${render(node.right, context, childOptions)})`
          const right = render(node.right, context, childOptions)
          const escape = node.escape
            ? ` ESCAPE ${render(node.escape, context, childOptions)}`
            : ''
          return `${left} ${operation.toUpperCase()} ${right}${escape}`
        }).join(operation.startsWith('not') || operation === '!=' || operation === '<>' ? ' AND ' : ' OR ')})`
      }
      const left = render(node.left, context, childOptions)
      if (operation.includes('between')) {
        return `(${left} ${operation.toUpperCase()} ${render(node.right.left, context, childOptions)} AND ${render(node.right.right, context, childOptions)})`
      }
      if (operation.includes('in')) return `(${left} ${operation.toUpperCase()} (${render(node.right, context, childOptions)}))`
      const right = render(node.right, context, childOptions)
      const escape = node.escape
        ? ` ESCAPE ${render(node.escape, context, childOptions)}`
        : ''
      return `(${left} ${operation.toUpperCase()} ${right}${escape})`
    }
  }
  if (node.type === 'condition') {
    const conditionOptions = { ...options, allowIndexedPredicate: false }
    if (node.variant === 'when') return `WHEN ${render(node.condition, context, conditionOptions)} THEN ${render(node.consequent, context, conditionOptions)}`
    if (node.variant === 'else') return `ELSE ${render(node.consequent, context, conditionOptions)}`
  }
  throw new Error(`Unsupported SQL syntax: ${node.type || 'unknown'}:${node.variant || ''}`)
}

/**
 * @param {any} statement
 * @param {ReturnType<typeof createContext>} context
 */
function renderClauses(statement, context) {
  let sql = ''
  if (statement.where?.length) {
    sql += ` WHERE ${statement.where.map(
      (/** @type {any} */ entry) => render(entry, context, { allowIndexedPredicate: true }),
    ).join(' AND ')}`
  }
  if (statement.group) sql += ` GROUP BY ${render(statement.group, context, { allowResultAlias: true })}`
  if (statement.having) sql += ` HAVING ${render(statement.having, context, { allowResultAlias: true })}`
  if (statement.order?.length) sql += ` ORDER BY ${statement.order.map((/** @type {any} */ entry) => render(entry, context, { allowResultAlias: true })).join(', ')}`
  if (statement.limit) sql += ` LIMIT ${render(statement.limit, context)}`
  return sql
}

/**
 * Extracts canonical field identities from parsed clauses. This deliberately
 * records structure rather than parameter values or source aliases.
 * @param {import('./collection.js').CollectionStore} store
 * @param {any} statement
 */
function queryFieldUsage(store, statement) {
  const context = createContext(store, statement, undefined)
  /** @type {Map<string, { fieldId: number, path: string, kind: 'equality' | 'range' | 'order' | 'other' }>} */
  const usage = new Map()

  const addIdentifiers = (node, kind) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const entry of node) addIdentifiers(entry, kind)
      return
    }
    if (node.type === 'identifier' && !String(node.name).startsWith(namedParameterPrefix)) {
      for (const field of resolveFields(context, String(node.name))) {
        usage.set(`${field.id}:${kind}`, { fieldId: field.id, path: field.path, kind })
      }
      return
    }
    for (const value of Object.values(node)) addIdentifiers(value, kind)
  }

  const visitFilter = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const entry of node) visitFilter(entry)
      return
    }
    if (node.type === 'expression' && node.variant === 'operation') {
      const operation = String(node.operation || '').toLowerCase()
      if (operation === 'and' || operation === 'or') {
        visitFilter(node.left)
        visitFilter(node.right)
        return
      }
      const staticRight = operation.includes('between')
        ? isStaticValue(node.right?.left) && isStaticValue(node.right?.right)
        : isStaticValue(node.right)
      // Keep learning aligned with renderIndexedPredicate(). An index should
      // never be created for a function, field-to-field comparison, HAVING
      // expression, or another shape that the compiler cannot accelerate.
      if (
        node.left?.type === 'identifier' &&
        indexedOperations.has(operation) &&
        staticRight &&
        (!node.escape || isStaticValue(node.escape))
      ) {
        const kind = ['=', '==', 'is', 'in'].includes(operation)
          ? 'equality'
          : ['<', '<=', '>', '>=', 'between', 'like', 'glob'].includes(operation)
            ? 'range'
            : 'other'
        addIdentifiers(node.left, kind)
      }
      return
    }
    for (const value of Object.values(node)) visitFilter(value)
  }

  visitFilter(statement.where)
  addIdentifiers(statement.order, 'order')
  addIdentifiers(statement.group, 'order')
  return Object.freeze([...usage.values()].map((entry) => Object.freeze(entry)))
}

/**
 * @typedef {{ alias: string, hidden: string, fieldId: number, hydrateObject: boolean }} TypeMetadata
 * @typedef {{ fieldId: number, path: string, kind: 'equality' | 'range' | 'order' | 'other' }} QueryFieldUsage
 * @typedef {{ sql: string, parameters: unknown[], metadata: TypeMetadata[], statement: any, usage: readonly QueryFieldUsage[], mode: 'rows' | 'documents', hiddenIdentity: string | null, objectProjectionError: string | null }} CompiledSql
 */

/**
 * @param {import('./collection.js').CollectionStore} store
 * @param {string} sourceSql
 * @param {unknown} parameters
 * @returns {Promise<CompiledSql>}
 */
export async function compileSelect(store, sourceSql, parameters) {
  const statement = await parseSql(sourceSql)
  if (statement.variant !== 'select') throw new Error('Expected a SELECT statement')
  const context = createContext(store, statement, parameters)
  if (isDocumentProjection(statement, context)) {
    if (statement.distinct) {
      throw new Error('SELECT * returns complete documents and does not support DISTINCT')
    }
    if (statement.group || statement.having) {
      throw new Error(
        'SELECT * returns complete documents and does not support GROUP BY or HAVING; select explicit scalar fields for grouped results',
      )
    }
    const compiled = compileObjectIds(store, statement, parameters)
    return {
      ...compiled,
      metadata: [],
      statement,
      mode: 'documents',
      hiddenIdentity: null,
      objectProjectionError: null,
    }
  }
  const sourceAliases = sourceResultAliases(sourceSql)
  /** @type {string[]} */
  const selections = []
  /** @type {TypeMetadata[]} */
  const metadata = []
  const unavailableHiddenAliases = new Set([
    'object_id',
    ...sourceAliases,
    ...statement.result.map((/** @type {any} */ result) => result.alias),
    ...store.fields.flatMap((field) => [field.name, field.path]),
  ].filter(Boolean).map((alias) => String(alias).toLowerCase()))
  let hiddenIndex = 0
  const nextHiddenAlias = () => {
    let alias
    do alias = `__ev3_idb_internal_type_${hiddenIndex++}__`
    while (unavailableHiddenAliases.has(alias.toLowerCase()))
    unavailableHiddenAliases.add(alias.toLowerCase())
    return alias
  }
  const aggregate = statement.result.some(hasAggregate)
  const objectProjectionError = statement.distinct
    ? 'Object projections do not support DISTINCT; select scalar descendants or retrieve complete documents first'
    : aggregate
      ? 'Object projections cannot be combined with aggregate results; select scalar descendants or use a separate query'
      : statement.group || statement.having
        ? 'Object projections do not support GROUP BY or HAVING; group by scalar descendants instead'
        : null
  const outputAliases = new Set()
  const registerAlias = (alias) => {
    const normalized = String(alias).toLowerCase()
    if (outputAliases.has(normalized)) {
      throw new Error(`Duplicate SELECT output alias: ${alias}`)
    }
    outputAliases.add(normalized)
  }
  const hasExplicitObjectId = statement.result.some(
    (/** @type {any} */ result) => result.type === 'identifier' &&
      normalizedReference(context, String(result.name)).toLowerCase() === 'object_id',
  )
  if (!aggregate && !statement.distinct && !hasExplicitObjectId) {
    registerAlias('object_id')
    selections.push(quoteIdentifier('object_id'))
  }

  for (let resultIndex = 0; resultIndex < statement.result.length; resultIndex++) {
    const result = statement.result[resultIndex]
    const explicitAlias = sourceAliases[resultIndex] || result.alias
    if (
      result.type === 'identifier' &&
      normalizedReference(context, String(result.name)).toLowerCase() === 'object_id'
    ) {
      const alias = String(explicitAlias || 'object_id')
      registerAlias(alias)
      selections.push(`${quoteIdentifier('object_id')} AS ${quoteIdentifier(alias)}`)
      context.resultAliases.add(alias.toLowerCase())
      continue
    }
    /** @type {import('./collection.js').Field[]} */
    let fields = []
    if (result.type === 'identifier' && ['column', 'star'].includes(result.variant)) {
      fields = resolveFields(context, String(result.name))
    } else if (result.type === 'variable' && result.name === '?') {
      fields = resolveFields(context, '?')
    }

    if (fields.length) {
      if (explicitAlias && fields.length > 1) {
        throw new Error(`Alias "${explicitAlias}" applies to multiple fields; use an exact path`)
      }
      const reference = result.type === 'variable'
        ? '?'
        : normalizedReference(context, String(result.name))
      const wildcardProjection = result.variant === 'star' || reference === '?' ||
        reference.endsWith('.*') || reference.endsWith('.?')
      for (const field of fields) {
        const alias = String(explicitAlias || defaultFieldAlias(context, field))
        registerAlias(alias)
        const hidden = nextHiddenAlias()
        selections.push(`${fieldReference(context, field)} AS ${quoteIdentifier(alias)}`)
        const storedType = quoteIdentifier(`__t_${field.id}`)
        const outputType = statement.distinct
          ? `CASE WHEN ${storedType} IN (${ValueType.text}, ${ValueType.array}, ${ValueType.object}, ${ValueType.binary}) THEN ${storedType} ELSE 0 END`
          : storedType
        selections.push(`${outputType} AS ${quoteIdentifier(hidden)}`)
        metadata.push({
          alias,
          hidden,
          fieldId: field.id,
          hydrateObject: !wildcardProjection,
        })
        context.resultAliases.add(alias.toLowerCase())
      }
      continue
    }

    const expression = render(result, context)
    const alias = String(explicitAlias || result.alias || expression.replace(/^\(|\)$/g, ''))
    registerAlias(alias)
    selections.push(`${expression} AS ${quoteIdentifier(alias)}`)
    context.resultAliases.add(alias.toLowerCase())
  }

  let hiddenIdentity = null
  if (metadata.some(({ hydrateObject }) => hydrateObject) && !objectProjectionError) {
    hiddenIdentity = nextHiddenAlias()
    selections.push(`${quoteIdentifier('object_id')} AS ${quoteIdentifier(hiddenIdentity)}`)
  }
  if (!selections.length) selections.push(quoteIdentifier('object_id'))
  const clauses = renderClauses(statement, context)
  const dataset = store.datasetCte([...context.required.values()])
  const distinct = statement.distinct ? 'DISTINCT ' : ''
  return {
    sql: `WITH ${quoteIdentifier('__idb_dataset')} AS (${dataset})
      SELECT ${distinct}${selections.join(', ')} FROM ${quoteIdentifier('__idb_dataset')}${clauses}`,
    parameters: context.bindings.values,
    metadata,
    statement,
    usage: queryFieldUsage(store, statement),
    mode: 'rows',
    hiddenIdentity,
    objectProjectionError,
  }
}

/**
 * Compiles only document selection while retaining WHERE/GROUP/ORDER/LIMIT.
 * @param {import('./collection.js').CollectionStore} store
 * @param {any} statement
 * @param {unknown} parameters
 */
export function compileObjectIds(store, statement, parameters) {
  const context = createContext(store, statement, parameters)
  const clauses = renderClauses(statement, context)
  const dataset = store.datasetCte([...context.required.values()])
  return {
    sql: `WITH ${quoteIdentifier('__idb_dataset')} AS (${dataset})
      SELECT ${quoteIdentifier('object_id')} FROM ${quoteIdentifier('__idb_dataset')}${clauses}`,
    parameters: context.bindings.values,
    usage: queryFieldUsage(store, statement),
  }
}

/**
 * Evaluates a SET expression for selected objects using SQLite itself.
 * @param {import('./collection.js').CollectionStore} store
 * @param {any} statement
 * @param {any} expression
 * @param {unknown} parameters
 * @param {number[]} objectIds
 */
export function compileExpression(store, statement, expression, parameters, objectIds) {
  const context = createContext(store, statement, parameters)
  if (
    expression?.type === 'variable' ||
    (expression?.type === 'identifier' && String(expression.name).startsWith(namedParameterPrefix))
  ) {
    return {
      sql: '',
      parameters: [],
      direct: { kind: 'value', value: context.bindings.resolve(expression) },
    }
  }
  if (expression?.type === 'identifier') {
    const fields = resolveFields(context, String(expression.name))
    if (fields.length === 1) {
      return {
        sql: '',
        parameters: [],
        direct: { kind: 'field', path: fields[0].path },
      }
    }
  }
  const rendered = render(expression, context)
  const dataset = store.datasetCte([...context.required.values()])
  if (!objectIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Invalid internal object id')
  }
  return {
    sql: `WITH ${quoteIdentifier('__idb_dataset')} AS (${dataset})
      SELECT object_id, ${rendered} AS value FROM ${quoteIdentifier('__idb_dataset')}
      WHERE object_id IN (${objectIds.join(', ')})`,
    parameters: context.bindings.values,
    direct: null,
  }
}

/**
 * @param {import('./collection.js').CollectionStore} store
 * @param {Record<string, unknown>[]} rows
 * @param {TypeMetadata[]} metadata
 * @param {string | null} hiddenIdentity
 * @param {string | null} objectProjectionError
 */
export async function decodeSelectRows(
  store,
  rows,
  metadata,
  hiddenIdentity,
  objectProjectionError,
) {
  /** @type {Map<number, Set<number>>} */
  const requested = new Map()
  for (const row of rows) {
    for (const entry of metadata) {
      const type = Number(row[entry.hidden])
      if (type !== ValueType.object || !entry.hydrateObject) continue
      if (objectProjectionError) throw new Error(objectProjectionError)
      const objectId = Number(hiddenIdentity && row[hiddenIdentity])
      if (!Number.isSafeInteger(objectId) || objectId < 1) {
        throw new Error('IDB integrity error: structured projection is missing its object identity')
      }
      let objectIds = requested.get(entry.fieldId)
      if (!objectIds) {
        objectIds = new Set()
        requested.set(entry.fieldId, objectIds)
      }
      objectIds.add(objectId)
    }
  }

  const allObjectIds = [...new Set([...requested.values()].flatMap((values) => [...values]))]
  const projected = requested.size
    ? await store.readSubtrees(allObjectIds, [...requested.keys()])
    : new Map()
  for (const row of rows) {
    const objectId = Number(hiddenIdentity && row[hiddenIdentity])
    for (const { alias, hidden, fieldId, hydrateObject } of metadata) {
      const type = Number(row[hidden])
      delete row[hidden]
      if (type === ValueType.object && hydrateObject) {
        const subtree = projected.get(fieldId)?.get(objectId)
        if (subtree === undefined) {
          throw new Error(`IDB integrity error: projected object ${fieldId} could not be reconstructed`)
        }
        row[alias] = deepClone(subtree)
      } else if (type === ValueType.text || type === ValueType.array || type === ValueType.binary) {
        row[alias] = decodeValue(type, null, null, row[alias])
      }
    }
    if (hiddenIdentity) delete row[hiddenIdentity]
  }
  return rows
}
