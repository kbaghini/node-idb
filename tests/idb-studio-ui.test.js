import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// A small event/DOM test double for request coordination. Real layout and
// rendering are additionally exercised in the browser during Studio review.
class Element {
  constructor() {
    this.dataset = {}
    this.children = []
    this.handlers = new Map()
    this.value = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.open = false
    this.classList = { contains: () => false, add() {}, remove() {}, toggle() {} }
  }
  addEventListener(name, handler) { this.handlers.set(name, handler) }
  get childNodes() { return this.children }
  dispatch(name, event = { type: name }) { return this.handlers.get(name)?.(event) }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute() {}
  querySelector() { return new Element() }
}

const source = await readFile(new URL('../src/studio/public/studio.js', import.meta.url), 'utf8')
const startup = source.lastIndexOf('\nattachEvents();')
assert.ok(startup > 0)

function harness() {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)
  }
  const context = vm.createContext({
    AbortController, URLSearchParams, performance, Node: Element,
    window: { location: { hash: '', pathname: '/', search: '' } },
    sessionStorage: { getItem: () => '' },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => new Element(), createTextNode: (text) => text,
    },
    setTimeout() {},
  })
  const evaluate = (code) => vm.runInContext(code, context)
  evaluate(source.slice(0, startup))
  evaluate(`app.selectedDatabaseId = 'db'; app.selectedCollection = 'records';
    renderDocuments = () => { elements['document-rows'].textContent = 'loaded'; };
    attachEvents();`)
  element('page-size').value = '25'
  element('document-order').value = 'asc'
  element('query-editor').value = 'SELECT * FROM records'
  element('query-parameters').value = '[]'
  return { context, evaluate, element }
}

const response = (payload) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => payload })

test('Studio Reload button applies the response rather than treating its click event as a selection version', async () => {
  const ui = harness()
  ui.context.fetch = async () => response({ documents: [{ objectId: 1, document: ['object', []] }], total: 1 })
  await ui.element('reload-documents').dispatch('click')
  assert.equal(ui.evaluate('app.documents.length'), 1)
  assert.equal(ui.element('document-rows').textContent, 'loaded')
  assert.equal(ui.element('reload-documents').disabled, false)
})

test('Studio cancels superseded document requests and ignores out-of-order responses', async () => {
  const ui = harness()
  const pending = []
  ui.context.fetch = (_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal }))
  const first = ui.evaluate('loadDocuments()')
  const second = ui.evaluate('loadDocuments()')
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(response({ documents: [{ objectId: 2, document: ['null'] }], total: 1 }))
  await second
  pending[0].resolve(response({ documents: [{ objectId: 1, document: ['null'] }], total: 1 }))
  await first
  assert.equal(ui.evaluate('app.documents[0].objectId'), 2)
})

test('Studio Cancel query aborts the HTTP read and restores its controls without an error toast', async () => {
  const ui = harness()
  ui.context.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const query = ui.evaluate('runQuery()')
  assert.equal(ui.element('cancel-query').hidden, false)
  ui.element('cancel-query').dispatch('click')
  await query
  assert.equal(ui.element('query-result-title').textContent, 'Query cancelled')
  assert.equal(ui.element('cancel-query').hidden, true)
  assert.equal(ui.element('run-query').disabled, false)
  assert.equal(ui.element('toast-region').children.length, 0)
})

test('Studio creates result detail trees only when expanded and previews skip invisible tails', () => {
  const ui = harness()
  ui.evaluate(`let treesRendered = 0; renderWireTree = () => { treesRendered++; return document.createElement('div'); };
    renderQueryResults([['object', []], ['object', []]], { duration: 1 });`)
  assert.equal(ui.evaluate('treesRendered'), 0)
  const first = ui.element('query-results').children[0]
  first.open = true
  first.dispatch('toggle')
  first.dispatch('toggle')
  assert.equal(ui.evaluate('treesRendered'), 1)
  const preview = ui.evaluate(`(() => {
    const values = [['string', 'x'.repeat(10000)]];
    Object.defineProperty(values, 1, { get() { throw new Error('Invisible tail was visited'); } });
    return wirePreview(['array', values]);
  })()`)
  assert.ok(preview.length <= 220)
  assert.ok(preview.endsWith('…'))
})

test('overlapping busy states preserve the original button content and accessibility markup', () => {
  const ui = harness()
  const icon = new Element()
  ui.element('run-query').append(icon, 'Run query')
  ui.evaluate(`setButtonBusy(elements['run-query'], true, 'Running…');
    setButtonBusy(elements['run-query'], true, 'Running…');
    setButtonBusy(elements['run-query'], false);`)
  assert.equal(ui.element('run-query').children[0], icon)
  assert.equal(ui.element('run-query').children[1], 'Run query')
  assert.equal(ui.element('run-query').disabled, false)
})
