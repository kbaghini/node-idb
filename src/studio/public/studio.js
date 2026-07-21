/*
 * Frontend contract: all document values and query parameters cross the API as
 * tagged wire nodes. Discovery and diagnostics metadata remain ordinary JSON.
 */

const TOKEN_SESSION_KEY = "node-idb-studio-token";
const TYPE_ENVELOPE_KEY = "$nodeIdb";
const KNOWN_WIRE_TAGS = new Set([
  "null",
  "undefined",
  "boolean",
  "number",
  "string",
  "bigint",
  "date",
  "binary",
  "array",
  "object",
]);
const FRIENDLY_TYPES = new Set(["undefined", "number", "bigint", "date", "binary", "object"]);

const elements = Object.fromEntries(
  [
    "connection-dot",
    "connection-label",
    "mode-badge",
    "root-summary",
    "refresh-button",
    "database-count",
    "navigator-filter",
    "navigator-tree",
    "breadcrumbs",
    "context-meta",
    "browse-title",
    "browse-subtitle",
    "page-size",
    "document-order",
    "reload-documents",
    "browse-empty",
    "document-table",
    "document-rows",
    "pagination",
    "page-summary",
    "page-number",
    "previous-page",
    "next-page",
    "structure-title",
    "structure-subtitle",
    "structure-metrics",
    "structure-empty",
    "structure-tree",
    "structure-list",
    "structure-list-body",
    "structure-tree-mode",
    "structure-list-mode",
    "reload-structure",
    "query-editor",
    "query-parameters",
    "parameters-help",
    "parameters-guide",
    "format-query",
    "run-query",
    "builder-fields",
    "builder-filter-field",
    "builder-operator",
    "builder-value",
    "builder-order-field",
    "builder-direction",
    "builder-limit",
    "build-query",
    "reset-builder",
    "query-result-title",
    "query-timing",
    "query-results",
    "write-heading",
    "write-rule",
    "document-id-field",
    "document-id",
    "document-editor",
    "editor-validation",
    "submit-document",
    "reset-document-editor",
    "analyze-database",
    "optimize-indexes",
    "load-diagnostics",
    "diagnostic-metrics",
    "diagnostics-json",
    "copy-diagnostics",
    "footer-dot",
    "footer-status",
    "footer-selection",
    "delete-dialog",
    "delete-message",
    "confirm-delete",
    "toast-region",
  ].map((id) => [id, document.getElementById(id)]),
);

const app = {
  token: readLaunchToken(),
  state: null,
  databases: [],
  selectedDatabaseId: null,
  selectedCollection: null,
  openDatabases: new Set(),
  schema: null,
  schemaFields: [],
  structureView: "tree",
  documents: [],
  page: 0,
  hasMore: false,
  total: null,
  pendingDelete: null,
  editTarget: null,
  diagnostics: null,
  requestCount: 0,
  selectionVersion: 0,
  schemaRequestVersion: 0,
  documentRequestVersion: 0,
};

function readLaunchToken() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const fragmentToken = params.get("token") || "";
  let token = fragmentToken;

  try {
    if (fragmentToken) sessionStorage.setItem(TOKEN_SESSION_KEY, fragmentToken);
    else token = sessionStorage.getItem(TOKEN_SESSION_KEY) || "";
  } catch {
    // Private browsing policies may disable session storage; this launch still works.
  }

  if (window.location.hash) {
    history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

function createElement(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "attributes") {
      for (const [name, attributeValue] of Object.entries(value)) {
        if (attributeValue !== undefined && attributeValue !== null) {
          node.setAttribute(name, String(attributeValue));
        }
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) {
      node[key] = value;
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setConnection(status, message) {
  elements["connection-dot"].className = `status-dot${status === "connected" ? " is-connected" : status === "error" ? " is-error" : ""}`;
  elements["footer-dot"].className = status === "connected" ? "is-connected" : status === "error" ? "is-error" : "";
  elements["connection-label"].textContent = message;
  elements["footer-status"].textContent = message;
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
}

function toast(title, message = "", kind = "success") {
  const content = createElement("div", {}, [createElement("strong", { text: title })]);
  if (message) content.append(createElement("span", { text: message }));
  const close = createElement("button", {
    text: "\u00d7",
    type: "button",
    attributes: { "aria-label": "Dismiss notification" },
  });
  const item = createElement("div", { className: `toast${kind === "error" ? " is-error" : ""}` }, [content, close]);
  close.addEventListener("click", () => item.remove());
  elements["toast-region"].append(item);
  window.setTimeout(() => item.remove(), kind === "error" ? 9000 : 4500);
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Unknown error");
}

async function api(path, { method = "GET", body, signal } = {}) {
  app.requestCount += 1;
  const headers = { Accept: "application/json" };
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
      const detail =
        typeof payload === "object" && payload
          ? payload.error?.message || payload.error || payload.message
          : payload;
      const error = new Error(detail || `Request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    app.requestCount = Math.max(0, app.requestCount - 1);
  }
}

function unwrapPayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.data !== undefined) {
    return payload.data;
  }
  return payload;
}

function isWireNode(value) {
  return Array.isArray(value) && typeof value[0] === "string" && KNOWN_WIRE_TAGS.has(value[0]);
}

function plainValueToWire(value, depth = 0) {
  if (depth > 100) throw new Error("Value is nested too deeply.");
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (Number.isFinite(value)) return ["number", value];
    return ["number", String(value)];
  }
  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["binary", bytesToBase64(value)];
  if (Array.isArray(value)) return ["array", value.map((item) => plainValueToWire(item, depth + 1))];
  if (typeof value === "object") {
    return [
      "object",
      Object.entries(value).map(([key, item]) => [key, plainValueToWire(item, depth + 1)]),
    ];
  }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

function ensureWireNode(value) {
  return isWireNode(value) ? value : plainValueToWire(value);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeBase64(value) {
  if (typeof value !== "string") throw new Error("Binary values require a base64 string.");
  if (value === "") return "";
  try {
    const compact = value.replace(/\s/g, "");
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error();
    return btoa(atob(compact));
  } catch {
    throw new Error("Binary value is not valid base64.");
  }
}

function isFriendlyEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== TYPE_ENVELOPE_KEY) return false;
  const body = value[TYPE_ENVELOPE_KEY];
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && FRIENDLY_TYPES.has(body.type));
}

function friendlyToWire(value, depth = 0) {
  if (depth > 100) throw new Error("Value is nested too deeply.");
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return ["number", value];
  if (typeof value === "string") return ["string", value];
  if (Array.isArray(value)) return ["array", value.map((item) => friendlyToWire(item, depth + 1))];

  if (!value || typeof value !== "object") throw new Error(`Unsupported JSON value: ${typeof value}`);

  if (isFriendlyEnvelope(value)) {
    const envelope = value[TYPE_ENVELOPE_KEY];
    switch (envelope.type) {
      case "undefined":
        return ["undefined"];
      case "number": {
        const special = String(envelope.value);
        if (!["NaN", "Infinity", "-Infinity"].includes(special)) {
          throw new Error("Typed number must be NaN, Infinity, or -Infinity.");
        }
        return ["number", special];
      }
      case "bigint": {
        const integer = String(envelope.value);
        if (!/^-?\d+$/.test(integer)) throw new Error("BigInt requires a decimal integer string.");
        return ["bigint", integer];
      }
      case "date": {
        const iso = String(envelope.value);
        const date = new Date(iso);
        if (!iso || Number.isNaN(date.getTime())) throw new Error("Date requires a valid ISO timestamp.");
        return ["date", date.toISOString()];
      }
      case "binary": {
        const base64 = normalizeBase64(String(envelope.value ?? ""));
        return ["binary", base64];
      }
      case "object": {
        if (!Array.isArray(envelope.entries)) throw new Error("Escaped objects require an entries array.");
        const seen = new Set();
        const entries = envelope.entries.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            throw new Error("Each escaped object entry must be [key, value].");
          }
          if (seen.has(entry[0])) throw new Error(`Duplicate object key: ${entry[0]}`);
          seen.add(entry[0]);
          return [entry[0], friendlyToWire(entry[1], depth + 1)];
        });
        return ["object", entries];
      }
      default:
        throw new Error(`Unsupported typed value: ${envelope.type}`);
    }
  }

  return [
    "object",
    Object.entries(value).map(([key, item]) => [key, friendlyToWire(item, depth + 1)]),
  ];
}

function wireToFriendly(node, depth = 0) {
  if (depth > 100) throw new Error("Wire value is nested too deeply.");
  if (!isWireNode(node)) return wireToFriendly(plainValueToWire(node), depth);
  const [tag, value] = node;
  switch (tag) {
    case "null":
      return null;
    case "undefined":
      return { [TYPE_ENVELOPE_KEY]: { type: "undefined" } };
    case "boolean":
    case "string":
      return value;
    case "number":
      return typeof value === "number"
        ? value
        : { [TYPE_ENVELOPE_KEY]: { type: "number", value: String(value) } };
    case "bigint":
      return { [TYPE_ENVELOPE_KEY]: { type: "bigint", value: String(value) } };
    case "date":
      return { [TYPE_ENVELOPE_KEY]: { type: "date", value: String(value) } };
    case "binary":
      return { [TYPE_ENVELOPE_KEY]: { type: "binary", value: String(value) } };
    case "array":
      return (Array.isArray(value) ? value : []).map((item) => wireToFriendly(item, depth + 1));
    case "object": {
      const entries = Array.isArray(value) ? value : [];
      const decoded = Object.fromEntries(entries.map(([key, item]) => [key, wireToFriendly(item, depth + 1)]));
      if (isFriendlyEnvelope(decoded)) {
        return {
          [TYPE_ENVELOPE_KEY]: {
            type: "object",
            entries: entries.map(([key, item]) => [key, wireToFriendly(item, depth + 1)]),
          },
        };
      }
      return decoded;
    }
    default:
      throw new Error(`Unknown wire type: ${tag}`);
  }
}

function parseFriendlyJson(text, label = "Value") {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return friendlyToWire(value);
}

function wireToEditorText(node) {
  return JSON.stringify(wireToFriendly(ensureWireNode(node)), null, 2);
}

function wirePreview(node, maxLength = 220) {
  const text = JSON.stringify(wireToFriendly(ensureWireNode(node)));
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}\u2026` : text;
}

function normalizeState(payload) {
  const raw = unwrapPayload(payload) || {};
  const databases = Array.isArray(raw.databases) ? raw.databases : [];
  return {
    ...raw,
    writable: raw.writable === true,
    databases: databases
      .map((database, index) => {
        const collectionsRaw = Array.isArray(database.collections) ? database.collections : [];
        const collections = collectionsRaw
          .map((collection) => {
            if (typeof collection === "string") return { name: collection };
            const name = collection?.name ?? collection?.collection ?? collection?.id;
            return name ? { ...collection, name: String(name) } : null;
          })
          .filter(Boolean);
        const id = database.id ?? database.databaseId ?? `database-${index}`;
        return {
          ...database,
          id: String(id),
          name: String(database.name ?? database.label ?? id),
          collections,
        };
      })
      .filter((database) => database.id),
  };
}

function getSelectedDatabase() {
  return app.databases.find((database) => database.id === app.selectedDatabaseId) || null;
}

function getSelectedCollectionInfo() {
  return getSelectedDatabase()?.collections.find((collection) => collection.name === app.selectedCollection) || null;
}

function renderConnectionState() {
  const writable = app.state?.writable === true;
  elements["mode-badge"].textContent = writable ? "writes enabled" : "read only";
  elements["mode-badge"].classList.toggle("is-writable", writable);
  for (const item of document.querySelectorAll(".write-only")) {
    if (item.classList.contains("tab-panel")) item.hidden = !writable || !item.classList.contains("is-active");
    else item.hidden = !writable;
  }
  if (!writable && document.getElementById("write-panel").classList.contains("is-active")) {
    activatePanel("browse-panel");
  }
  elements["root-summary"].textContent = app.state?.rootPath || app.state?.rootLabel || "Local storage root";
  elements["root-summary"].title = app.state?.rootPath || "Studio storage root";
}

function renderNavigator() {
  const query = elements["navigator-filter"].value.trim().toLocaleLowerCase();
  elements["navigator-tree"].replaceChildren();
  elements["database-count"].textContent = String(app.databases.length);

  const matchingDatabases = app.databases
    .map((database) => {
      const dbMatches = database.name.toLocaleLowerCase().includes(query);
      const collections = database.collections.filter(
        (collection) => dbMatches || collection.name.toLocaleLowerCase().includes(query),
      );
      return { database, collections };
    })
    .filter(({ database, collections }) => !query || database.name.toLocaleLowerCase().includes(query) || collections.length);

  if (!matchingDatabases.length) {
    elements["navigator-tree"].append(
      createElement("div", {
        className: "navigator-empty",
        text: query ? "No databases or collections match this filter." : "No node-idb databases were discovered.",
      }),
    );
    return;
  }

  for (const { database, collections } of matchingDatabases) {
    const open = app.openDatabases.has(database.id) || Boolean(query);
    const node = createElement("div", { className: `database-node${open ? " is-open" : ""}` });
    const databaseButton = createElement(
      "button",
      {
        type: "button",
        className: "database-button",
        attributes: { "aria-expanded": open ? "true" : "false" },
      },
      [
        createElement("span", { className: "disclosure", text: "\u25b6", attributes: { "aria-hidden": "true" } }),
        createElement("span", { className: "database-glyph", attributes: { "aria-hidden": "true" } }),
        createElement("span", { className: "node-name", text: database.name, title: database.name }),
        createElement("span", { className: "node-count", text: database.collections.length }),
      ],
    );
    databaseButton.addEventListener("click", () => {
      const changingDatabase = app.selectedDatabaseId !== database.id;
      if (app.openDatabases.has(database.id)) app.openDatabases.delete(database.id);
      else app.openDatabases.add(database.id);
      if (changingDatabase && database.collections[0]) {
        app.openDatabases.add(database.id);
        selectCollection(database.id, database.collections[0].name);
        return;
      }
      if (changingDatabase) {
        app.selectedDatabaseId = database.id;
        app.selectedCollection = null;
        app.schema = null;
        app.schemaFields = [];
        app.documents = [];
        app.diagnostics = null;
        app.selectionVersion += 1;
        renderBrowseEmpty("No collections", "This database does not contain any discovered collections.");
        renderBuilderFields();
        renderStructure();
      }
      renderNavigator();
      updateContext();
    });

    const collectionList = createElement("div", { className: "collection-list" });
    for (const collection of collections) {
      const active = database.id === app.selectedDatabaseId && collection.name === app.selectedCollection;
      const button = createElement(
        "button",
        {
          type: "button",
          className: `collection-button${active ? " is-active" : ""}`,
          title: collection.name,
        },
        [
          createElement("span", { className: "collection-mini-glyph", attributes: { "aria-hidden": "true" } }),
          createElement("span", { className: "node-name", text: collection.name }),
          collection.recordCount !== undefined
            ? createElement("span", { className: "node-count", text: collection.recordCount })
            : null,
        ],
      );
      button.addEventListener("click", () => selectCollection(database.id, collection.name));
      collectionList.append(button);
    }
    if (!collections.length) {
      collectionList.append(createElement("div", { className: "navigator-empty", text: "No collections" }));
    }
    node.append(databaseButton, collectionList);
    elements["navigator-tree"].append(node);
  }
}

function updateContext() {
  const database = getSelectedDatabase();
  elements.breadcrumbs.replaceChildren();
  if (!database) {
    elements.breadcrumbs.append(createElement("span", { text: "No database selected" }));
    elements["context-meta"].textContent = "";
    elements["footer-selection"].textContent = "No collection selected";
    return;
  }
  elements.breadcrumbs.append(
    createElement("strong", { text: database.name }),
    createElement("span", { className: "breadcrumb-separator", text: "/", attributes: { "aria-hidden": "true" } }),
    createElement("span", { text: app.selectedCollection || "Choose a collection" }),
  );
  elements["context-meta"].textContent = `${database.collections.length} collection${database.collections.length === 1 ? "" : "s"}`;
  elements["footer-selection"].textContent = app.selectedCollection
    ? `${database.name} / ${app.selectedCollection}`
    : database.name;
}

function clearWriteTargets({ resetEditor = false } = {}) {
  app.editTarget = null;
  app.pendingDelete = null;
  if (elements["delete-dialog"].open) elements["delete-dialog"].close("cancel");
  if (resetEditor) resetDocumentEditor();
}

async function loadState({ preserveSelection = true } = {}) {
  setConnection("loading", "Connecting");
  try {
    const payload = await api("/api/state");
    const previousDatabase = preserveSelection ? app.selectedDatabaseId : null;
    const previousCollection = preserveSelection ? app.selectedCollection : null;
    const previousCatalogVersion = app.state?.catalogVersion;
    app.state = normalizeState(payload);
    app.databases = app.state.databases;
    const preservedDb = app.databases.find((database) => database.id === previousDatabase);
    const database = preservedDb || app.databases[0] || null;
    const nextDatabaseId = database?.id || null;
    const preservedCollection = database?.collections.find((collection) => collection.name === previousCollection);
    const nextCollection = preservedCollection?.name || database?.collections[0]?.name || null;
    if (
      previousCatalogVersion !== app.state.catalogVersion ||
      previousDatabase !== nextDatabaseId ||
      previousCollection !== nextCollection
    ) {
      clearWriteTargets({ resetEditor: true });
    }
    app.selectedDatabaseId = nextDatabaseId;
    app.openDatabases = new Set(database ? [database.id] : []);
    app.selectedCollection = nextCollection;
    renderConnectionState();
    renderNavigator();
    updateContext();
    setConnection("connected", "Local Studio connected");
    if (app.selectedCollection) await selectCollection(app.selectedDatabaseId, app.selectedCollection, { updateNavigator: false });
    else renderBrowseEmpty("No collection selected", "Choose a collection from the navigator.");
  } catch (error) {
    setConnection("error", "Connection failed");
    const message = error.status === 401 && !app.token
      ? "No Studio token was found. Open the complete URL printed by startStudio()."
      : errorMessage(error);
    elements["navigator-tree"].replaceChildren(
      createElement("div", { className: "navigator-empty", text: message }),
    );
    renderBrowseEmpty("Studio is unavailable", message);
    toast("Could not connect", message, "error");
  }
}

async function refreshDiscovery() {
  const glyph = elements["refresh-button"].querySelector(".refresh-glyph");
  elements["refresh-button"].disabled = true;
  glyph?.classList.add("is-spinning");
  try {
    await api("/api/refresh", { method: "POST", body: {} });
    await loadState({ preserveSelection: true });
    toast("Discovery refreshed", `${app.databases.length} database${app.databases.length === 1 ? "" : "s"} available.`);
  } catch (error) {
    toast("Refresh failed", errorMessage(error), "error");
  } finally {
    elements["refresh-button"].disabled = false;
    glyph?.classList.remove("is-spinning");
  }
}

async function selectCollection(databaseId, collectionName, { updateNavigator = true } = {}) {
  if (app.selectedDatabaseId !== databaseId || app.selectedCollection !== collectionName) {
    clearWriteTargets({ resetEditor: true });
  }
  const selectionVersion = ++app.selectionVersion;
  app.selectedDatabaseId = databaseId;
  app.selectedCollection = collectionName;
  app.openDatabases.add(databaseId);
  app.page = 0;
  app.schema = null;
  app.schemaFields = [];
  app.diagnostics = null;
  if (updateNavigator) renderNavigator();
  updateContext();
  const collection = getSelectedCollectionInfo();
  elements["browse-title"].textContent = collectionName;
  elements["browse-subtitle"].textContent = collection?.recordCount !== undefined
    ? `${collection.recordCount} stored document${collection.recordCount === 1 ? "" : "s"}`
    : "Stored documents and native values";
  renderStructure();
  setDefaultQuery();
  await Promise.all([loadSchema(selectionVersion), loadDocuments(selectionVersion)]);
}

function renderBrowseEmpty(title, description) {
  elements["document-table"].hidden = true;
  elements.pagination.hidden = true;
  elements["browse-empty"].hidden = false;
  const heading = elements["browse-empty"].querySelector("h3");
  const paragraph = elements["browse-empty"].querySelector("p");
  if (heading) heading.textContent = title;
  if (paragraph) paragraph.textContent = description;
}

function normalizeDocumentList(payload) {
  const raw = unwrapPayload(payload) || {};
  const items = Array.isArray(raw) ? raw : raw.documents || raw.rows || raw.items || [];
  const documents = items.map((item, index) => {
    if (isWireNode(item)) return { objectId: null, document: item, index };
    const objectId = item?.objectId ?? item?.object_id ?? item?.id ?? null;
    const document = item?.document ?? item?.value ?? item?.data ?? item;
    return { objectId, document: ensureWireNode(document), index };
  });
  return {
    documents,
    total: Number.isFinite(Number(raw.total)) ? Number(raw.total) : null,
    hasMore: typeof raw.hasMore === "boolean" ? raw.hasMore : documents.length >= Number(elements["page-size"].value),
  };
}

async function loadDocuments(expectedSelectionVersion = app.selectionVersion) {
  if (!app.selectedDatabaseId || !app.selectedCollection) {
    renderBrowseEmpty("No collection selected", "Choose a collection from the navigator.");
    return;
  }
  const pageSize = Number(elements["page-size"].value);
  const body = {
    databaseId: app.selectedDatabaseId,
    collection: app.selectedCollection,
    limit: pageSize,
    offset: app.page * pageSize,
    order: elements["document-order"].value,
  };
  const requestVersion = ++app.documentRequestVersion;
  elements["reload-documents"].disabled = true;
  elements["document-table"].hidden = false;
  elements["browse-empty"].hidden = true;
  elements["document-rows"].replaceChildren(
    createElement("tr", { className: "loading-row" }, [
      createElement("td", { text: "Loading documents\u2026", attributes: { colspan: "4" } }),
    ]),
  );
  try {
    const result = normalizeDocumentList(await api("/api/documents/list", { method: "POST", body }));
    if (expectedSelectionVersion !== app.selectionVersion || requestVersion !== app.documentRequestVersion) return;
    app.documents = result.documents;
    app.total = result.total;
    app.hasMore = result.hasMore;
    renderDocuments();
  } catch (error) {
    if (expectedSelectionVersion !== app.selectionVersion || requestVersion !== app.documentRequestVersion) return;
    app.documents = [];
    renderBrowseEmpty("Documents could not be loaded", errorMessage(error));
    toast("Browse failed", errorMessage(error), "error");
  } finally {
    if (requestVersion === app.documentRequestVersion) elements["reload-documents"].disabled = false;
  }
}

function renderDocuments() {
  elements["document-rows"].replaceChildren();
  if (!app.documents.length) {
    renderBrowseEmpty(
      app.page > 0 ? "No documents on this page" : "This collection is empty",
      app.page > 0 ? "Return to the previous page." : app.state?.writable ? "Use the Write tab to insert the first document." : "There are no records to display.",
    );
    if (app.page > 0) {
      elements.pagination.hidden = false;
      elements["previous-page"].disabled = false;
      elements["next-page"].disabled = true;
    }
    return;
  }

  elements["browse-empty"].hidden = true;
  elements["document-table"].hidden = false;
  for (const row of app.documents) renderDocumentRow(row);

  const pageSize = Number(elements["page-size"].value);
  const first = app.page * pageSize + 1;
  const last = first + app.documents.length - 1;
  elements.pagination.hidden = false;
  elements["page-number"].textContent = String(app.page + 1);
  elements["page-summary"].textContent = app.total === null
    ? `Showing ${first}–${last}`
    : `Showing ${first}–${last} of ${app.total}`;
  elements["previous-page"].disabled = app.page === 0;
  elements["next-page"].disabled = !app.hasMore;
}

function renderDocumentRow(row) {
  const identity = row.objectId ?? "\u2014";
  const detailId = `document-detail-${app.page}-${row.index}`;
  const expand = createElement("button", {
    type: "button",
    className: "expand-button",
    text: "+",
    title: "Expand document",
    attributes: { "aria-expanded": "false", "aria-controls": detailId },
  });
  const actionGroup = createElement("div", { className: "row-action-group" });
  if (app.state?.writable && row.objectId !== null) {
    const edit = createElement("button", { type: "button", className: "row-action", text: "Edit" });
    edit.addEventListener("click", () => beginEdit(row));
    const remove = createElement("button", { type: "button", className: "row-action danger", text: "Delete" });
    remove.addEventListener("click", () => requestDelete(row));
    actionGroup.append(edit, remove);
  }
  const mainRow = createElement("tr", {}, [
    createElement("td", {}, [expand]),
    createElement("td", {}, [createElement("span", { className: "object-id", text: identity })]),
    createElement("td", {}, [createElement("code", { className: "document-preview", text: wirePreview(row.document) })]),
    createElement("td", {}, [actionGroup]),
  ]);
  const detailRow = createElement("tr", { className: "document-detail-row", id: detailId, hidden: true }, [
    createElement("td", { attributes: { colspan: "4" } }),
  ]);
  let detailRendered = false;
  expand.addEventListener("click", () => {
    const opening = detailRow.hidden;
    detailRow.hidden = !opening;
    expand.setAttribute("aria-expanded", String(opening));
    expand.textContent = opening ? "\u2212" : "+";
    expand.title = opening ? "Collapse document" : "Expand document";
    if (opening && !detailRendered) {
      detailRow.firstElementChild.append(renderWireTree(row.document));
      detailRendered = true;
    }
  });
  elements["document-rows"].append(mainRow, detailRow);
}

function renderWireTree(input) {
  const root = createElement("div", { className: "tree-view" });
  const budget = { nodes: 0, exhausted: false };
  appendWireNode(root, ensureWireNode(input), null, 0, budget);
  return root;
}

function appendWireNode(container, node, key, depth, budget) {
  budget.nodes += 1;
  if (budget.nodes > 2000 || depth > 60) {
    if (!budget.exhausted) {
      container.append(createElement("div", { className: "tree-line tree-undefined", text: "\u2026 value truncated in viewer" }));
      budget.exhausted = true;
    }
    return;
  }
  const wire = ensureWireNode(node);
  const [tag, value] = wire;
  const keyNode = key === null
    ? null
    : createElement("span", { className: typeof key === "number" ? "tree-index" : "tree-key", text: typeof key === "number" ? `[${key}]` : JSON.stringify(key) });

  if (tag === "object" || tag === "array") {
    const entries = tag === "object" ? (Array.isArray(value) ? value : []) : (Array.isArray(value) ? value.map((item, index) => [index, item]) : []);
    const line = createElement("div", { className: "tree-line" });
    if (keyNode) line.append(keyNode, createElement("span", { className: "tree-punctuation", text: ":" }));
    line.append(
      createElement("span", { className: "type-badge", text: tag }),
      createElement("span", { className: "tree-punctuation", text: `${tag === "object" ? "{" : "["} ${entries.length} ${entries.length === 1 ? "item" : "items"}` }),
    );
    container.append(line);
    const branch = createElement("div", { className: "tree-branch" });
    for (const [childKey, child] of entries) appendWireNode(branch, child, childKey, depth + 1, budget);
    branch.append(createElement("div", { className: "tree-line tree-punctuation", text: tag === "object" ? "}" : "]" }));
    container.append(branch);
    return;
  }

  const line = createElement("div", { className: "tree-line" });
  if (keyNode) line.append(keyNode, createElement("span", { className: "tree-punctuation", text: ":" }));
  line.append(createElement("span", { className: "type-badge", text: tag }));
  const display = primitiveWireDisplay(tag, value);
  line.append(createElement("span", { className: `tree-${tag}`, text: display }));
  container.append(line);
}

function primitiveWireDisplay(tag, value) {
  switch (tag) {
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "date":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "binary":
      return `<base64 ${String(value).length} chars> ${String(value).slice(0, 40)}${String(value).length > 40 ? "\u2026" : ""}`;
    default:
      return String(value);
  }
}

async function loadSchema(
  expectedSelectionVersion = app.selectionVersion,
  { details = document.getElementById("structure-panel").classList.contains("is-active") } = {},
) {
  if (!app.selectedDatabaseId || !app.selectedCollection) return;
  const requestVersion = ++app.schemaRequestVersion;
  const path = `/api/databases/${encodeURIComponent(app.selectedDatabaseId)}/collections/${encodeURIComponent(app.selectedCollection)}/schema${details ? "" : "?summary=1"}`;
  elements["reload-structure"].disabled = true;
  try {
    const payload = unwrapPayload(await api(path)) || {};
    if (expectedSelectionVersion !== app.selectionVersion || requestVersion !== app.schemaRequestVersion) return;
    const rawFields = Array.isArray(payload) ? payload : payload.fields || payload.schema || [];
    app.schema = normalizeSchema(payload, rawFields);
    app.schemaFields = app.schema.fields
      .map((field) => field.path)
      .filter((field) => typeof field === "string" && field && field !== "object_id")
      .filter((field, index, all) => all.indexOf(field) === index)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (expectedSelectionVersion !== app.selectionVersion || requestVersion !== app.schemaRequestVersion) return;
    app.schema = null;
    app.schemaFields = [];
    toast("Schema unavailable", errorMessage(error), "error");
  } finally {
    if (expectedSelectionVersion === app.selectionVersion && requestVersion === app.schemaRequestVersion) {
      elements["reload-structure"].disabled = false;
    }
  }
  renderBuilderFields();
  renderStructure();
}

function normalizeSchema(payload, rawFields) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const fields = rawFields.map((rawField, index) => {
    if (typeof rawField === "string") {
      return {
        id: index + 1,
        name: rawField.split(".").at(-1) || rawField,
        level: rawField.split(".").length,
        parentFieldId: null,
        path: rawField,
        types: [],
        presentInDocuments: 0,
        coverage: 0,
        optional: true,
        coverageWithinParent: 0,
        optionalWithinParent: true,
        indexed: false,
      };
    }
    const types = Array.isArray(rawField?.types)
      ? rawField.types
        .filter((entry) => entry && typeof entry.type === "string")
        .map((entry) => ({ type: entry.type, count: Number(entry.count) || 0 }))
      : [];
    return {
      id: Number.isSafeInteger(Number(rawField?.id)) ? Number(rawField.id) : index + 1,
      name: String(rawField?.name ?? rawField?.alias ?? `field_${index + 1}`),
      level: Number.isSafeInteger(Number(rawField?.level)) ? Number(rawField.level) : 1,
      parentFieldId: rawField?.parentFieldId === null || rawField?.parent_field_id === null
        ? null
        : Number(rawField?.parentFieldId ?? rawField?.parent_field_id) || null,
      path: typeof rawField?.path === "string" ? rawField.path : String(rawField?.name ?? ""),
      types,
      presentInDocuments: Number(rawField?.presentInDocuments) || 0,
      coverage: Math.max(0, Math.min(1, Number(rawField?.coverage) || 0)),
      optional: rawField?.optional !== false,
      coverageWithinParent: Math.max(0, Math.min(1, Number(rawField?.coverageWithinParent) || 0)),
      optionalWithinParent: rawField?.optionalWithinParent !== false,
      indexed: rawField?.indexed === true,
    };
  });
  return {
    collection: String(source.collection || app.selectedCollection || ""),
    documentCount: Number(source.documentCount) || 0,
    statisticsIncluded: source.statisticsIncluded === true,
    fields,
    fieldIndexes: source.fieldIndexes || null,
    autoIndexing: source.autoIndexing || null,
  };
}

function renderStructure() {
  const collection = app.selectedCollection;
  elements["structure-title"].textContent = collection || "Choose a collection";
  if (!collection) {
    elements["structure-subtitle"].textContent = "Select a collection to inspect its field hierarchy.";
    renderStructureEmpty("No collection selected", "Choose a database and collection from the navigator.");
    return;
  }
  if (!app.schema) {
    elements["structure-subtitle"].textContent = "Loading field hierarchy and stored type information...";
    renderStructureEmpty("Loading structure", "Reading field metadata from the selected collection.");
    return;
  }
  if (!app.schema.statisticsIncluded) {
    elements["structure-subtitle"].textContent = "Loading observed types, coverage, and index details...";
    renderStructureEmpty("Loading structure details", "Field paths are ready; calculating details from stored documents.");
    return;
  }

  const schema = app.schema;
  const documentFields = schema.fields.filter((field) => field.parentFieldId !== null);
  const indexedFields = documentFields.filter((field) => field.indexed).length;
  const maxDepth = documentFields.reduce((maximum, field) => Math.max(maximum, field.level), 0);
  const policy = schema.fieldIndexes?.mode === "auto"
    ? `Auto (${schema.fieldIndexes.preset || "custom"})`
    : schema.fieldIndexes?.default
      ? `Manual (${schema.fieldIndexes.default})`
      : "Not reported";

  elements["structure-subtitle"].textContent = `${schema.documentCount.toLocaleString()} stored document${schema.documentCount === 1 ? "" : "s"}; field types reflect all current values.`;
  elements["structure-metrics"].replaceChildren(
    structureMetric("Documents", schema.documentCount.toLocaleString()),
    structureMetric("Fields", documentFields.length.toLocaleString()),
    structureMetric("Maximum depth", maxDepth.toLocaleString()),
    structureMetric("Indexed fields", indexedFields.toLocaleString()),
    structureMetric("Index policy", policy),
  );

  elements["structure-empty"].hidden = true;
  renderStructureTree(schema.fields);
  renderStructureList(documentFields);
  setStructureView(app.structureView);
}

function structureMetric(label, value) {
  return createElement("article", { className: "structure-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: value }),
  ]);
}

function renderStructureEmpty(title, description) {
  elements["structure-metrics"].replaceChildren();
  elements["structure-tree"].hidden = true;
  elements["structure-list"].hidden = true;
  elements["structure-empty"].hidden = false;
  elements["structure-empty"].querySelector("h3").textContent = title;
  elements["structure-empty"].querySelector("p").textContent = description;
}

function renderStructureTree(fields) {
  const children = new Map();
  for (const field of fields) {
    const key = field.parentFieldId === null ? "root" : String(field.parentFieldId);
    const bucket = children.get(key) || [];
    bucket.push(field);
    children.set(key, bucket);
  }
  elements["structure-tree"].replaceChildren();
  const roots = children.get("root") || [];
  for (const root of roots) elements["structure-tree"].append(renderSchemaNode(root, children, true));
  if (!roots.length) {
    for (const field of fields) elements["structure-tree"].append(renderSchemaNode(field, new Map(), false));
  }
}

function renderSchemaNode(field, children, root = false) {
  const descendants = children.get(String(field.id)) || [];
  const line = createElement("div", { className: `schema-node-line${root ? " is-root" : ""}` }, [
    createElement("span", { className: "schema-field-name", text: root ? app.schema.collection : field.name }),
    ...schemaTypeBadges(field.types),
    createElement("span", {
      className: `coverage-badge${field.optional ? " is-optional" : ""}`,
      text: `${Math.round(field.coverage * 100)}%`,
      title: `${field.presentInDocuments.toLocaleString()} of ${app.schema.documentCount.toLocaleString()} documents; ${Math.round(field.coverageWithinParent * 100)}% within parent objects`,
    }),
    field.indexed ? createElement("span", { className: "index-badge", text: "indexed" }) : null,
    !root && field.path ? createElement("code", { className: "schema-path", text: field.path }) : null,
  ]);
  if (!descendants.length) return createElement("div", { className: "schema-leaf" }, [line]);
  const details = createElement("details", { className: "schema-branch", open: true });
  details.append(createElement("summary", {}, [line]));
  const body = createElement("div", { className: "schema-children" });
  for (const descendant of descendants) body.append(renderSchemaNode(descendant, children));
  details.append(body);
  return details;
}

function schemaTypeBadges(types) {
  if (!types.length) return [createElement("span", { className: "schema-type is-empty", text: "no values" })];
  return types.map(({ type, count }) => createElement("span", {
    className: `schema-type type-${type.replace(/[^a-z0-9_-]/gi, "-")}`,
    text: type,
    title: `${Number(count).toLocaleString()} stored value${Number(count) === 1 ? "" : "s"}`,
  }));
}

function renderStructureList(fields) {
  elements["structure-list-body"].replaceChildren();
  for (const field of [...fields].sort((left, right) => left.path.localeCompare(right.path))) {
    const types = createElement("div", { className: "schema-types" }, schemaTypeBadges(field.types));
    const coverage = createElement("div", { className: "coverage-cell" }, [
      createElement("span", { text: `${Math.round(field.coverage * 100)}%` }),
      createElement("small", { text: `${field.presentInDocuments.toLocaleString()} / ${app.schema.documentCount.toLocaleString()} | ${Math.round(field.coverageWithinParent * 100)}% in parent` }),
    ]);
    elements["structure-list-body"].append(createElement("tr", {}, [
      createElement("td", {}, [createElement("code", { className: "list-field-path", text: field.path || field.name })]),
      createElement("td", {}, [types]),
      createElement("td", {}, [coverage]),
      createElement("td", { text: field.level }),
      createElement("td", {}, [field.indexed
        ? createElement("span", { className: "index-badge", text: "indexed" })
        : createElement("span", { className: "not-indexed", text: "not indexed" })]),
    ]));
  }
}

function setStructureView(view) {
  app.structureView = view === "list" ? "list" : "tree";
  const tree = app.structureView === "tree";
  elements["structure-tree-mode"].classList.toggle("is-active", tree);
  elements["structure-tree-mode"].setAttribute("aria-pressed", String(tree));
  elements["structure-list-mode"].classList.toggle("is-active", !tree);
  elements["structure-list-mode"].setAttribute("aria-pressed", String(!tree));
  if (app.schema) {
    elements["structure-tree"].hidden = !tree;
    elements["structure-list"].hidden = tree;
  }
}

function renderBuilderFields() {
  elements["builder-fields"].replaceChildren();
  elements["builder-filter-field"].replaceChildren(createElement("option", { value: "", text: "None" }));
  elements["builder-order-field"].replaceChildren(createElement("option", { value: "object_id", text: "object_id" }));
  if (!app.schemaFields.length) {
    elements["builder-fields"].append(createElement("option", { text: "No discovered fields", disabled: true }));
    return;
  }
  for (const field of app.schemaFields) {
    elements["builder-fields"].append(createElement("option", { value: field, text: field }));
    elements["builder-filter-field"].append(createElement("option", { value: field, text: field }));
    elements["builder-order-field"].append(createElement("option", { value: field, text: field }));
  }
}

function quoteIdentifier(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function setDefaultQuery() {
  if (!app.selectedCollection) return;
  elements["query-editor"].value = `SELECT *\nFROM ${quoteIdentifier(app.selectedCollection)}\nORDER BY object_id DESC\nLIMIT 25`;
  elements["query-parameters"].value = "[]";
}

function buildQuery() {
  if (!app.selectedCollection) {
    toast("Choose a collection", "The query builder needs a selected collection.", "error");
    return;
  }
  const selectedFields = Array.from(elements["builder-fields"].selectedOptions).map((option) => option.value);
  const filterField = elements["builder-filter-field"].value;
  const operator = elements["builder-operator"].value;
  const orderField = elements["builder-order-field"].value;
  const direction = elements["builder-direction"].value === "DESC" ? "DESC" : "ASC";
  const limit = Math.max(1, Math.min(500, Number(elements["builder-limit"].value) || 25));
  const projection = selectedFields.length ? selectedFields.map(quoteIdentifier).join(", ") : "*";
  const lines = [`SELECT ${projection}`, `FROM ${quoteIdentifier(app.selectedCollection)}`];
  const parameters = [];
  if (filterField) {
    const noValue = operator === "IS NULL" || operator === "IS NOT NULL";
    lines.push(`WHERE ${quoteIdentifier(filterField)} ${operator}${noValue ? "" : " ?"}`);
    if (!noValue) {
      const source = elements["builder-value"].value.trim();
      let value = source;
      if (source) {
        try {
          value = JSON.parse(source);
        } catch {
          value = source;
        }
      }
      parameters.push(value);
    }
  }
  lines.push(`ORDER BY ${orderField === "object_id" ? "object_id" : quoteIdentifier(orderField)} ${direction}`);
  lines.push(`LIMIT ${limit}`);
  elements["query-editor"].value = lines.join("\n");
  elements["query-parameters"].value = JSON.stringify(parameters, null, 2);
  toast("SELECT query built", "Review it in the editor, then run it.");
}

function resetBuilder() {
  for (const option of elements["builder-fields"].options) option.selected = false;
  elements["builder-filter-field"].value = "";
  elements["builder-operator"].value = "=";
  elements["builder-value"].value = "";
  elements["builder-order-field"].value = "object_id";
  elements["builder-direction"].value = "ASC";
  elements["builder-limit"].value = "25";
}

function formatQueryText(sql) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    current += character;
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) current += sql[(index += 1)];
        else {
          segments.push({ quoted: true, text: current });
          current = "";
          quote = null;
        }
      }
    } else if (character === "'" || character === '"' || character === "`") {
      if (current.length > 1) segments.push({ quoted: false, text: current.slice(0, -1) });
      current = character;
      quote = character;
    }
  }
  if (current) segments.push({ quoted: Boolean(quote), text: current });
  return segments
    .map((segment) => {
      if (segment.quoted) return segment.text;
      return segment.text
        .replace(/\s+/g, " ")
        .replace(/\s*;\s*/g, ";\n")
        .replace(/\s+\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET)\b/gi, "\n$1")
        .replace(/\s+\b(AND|OR)\b/gi, "\n  $1");
    })
    .join("")
    .trim();
}

async function runQuery() {
  if (!app.selectedDatabaseId) {
    toast("Choose a database", "A query needs a selected database.", "error");
    return;
  }
  const databaseId = app.selectedDatabaseId;
  const selectionVersion = app.selectionVersion;
  const statement = elements["query-editor"].value.trim();
  if (!/^SELECT\b/i.test(statement)) {
    toast("SELECT only", "The Studio query editor accepts canonical SELECT statements. FIND and mutations are not run here.", "error");
    return;
  }
  let parameters;
  try {
    parameters = parseFriendlyJson(elements["query-parameters"].value || "[]", "Parameters");
  } catch (error) {
    toast("Invalid parameters", errorMessage(error), "error");
    return;
  }
  setButtonBusy(elements["run-query"], true, "Running\u2026");
  const started = performance.now();
  try {
    const payload = unwrapPayload(await api("/api/query", {
      method: "POST",
      body: { databaseId, statement, parameters },
    })) || {};
    if (selectionVersion !== app.selectionVersion || databaseId !== app.selectedDatabaseId) return;
    const encodedRows = Array.isArray(payload) ? payload : payload.rows || payload.results || [];
    const rows = isWireNode(encodedRows) && encodedRows[0] === "array" ? encodedRows[1] : encodedRows;
    if (!Array.isArray(rows)) throw new Error("The Studio returned an invalid query result.");
    const duration = Number(payload.durationMs ?? performance.now() - started);
    renderQueryResults(rows.map(ensureWireNode), {
      duration,
      truncated: payload.truncated === true,
      limit: payload.limit,
    });
  } catch (error) {
    if (selectionVersion !== app.selectionVersion || databaseId !== app.selectedDatabaseId) return;
    elements["query-result-title"].textContent = "Query failed";
    elements["query-timing"].textContent = "";
    elements["query-results"].replaceChildren(
      createElement("div", { className: "empty-state compact" }, [
        createElement("h3", { text: "The SELECT statement could not be completed" }),
        createElement("p", { text: errorMessage(error) }),
      ]),
    );
    toast("Query failed", errorMessage(error), "error");
  } finally {
    setButtonBusy(elements["run-query"], false);
  }
}

function renderQueryResults(rows, metadata) {
  elements["query-results"].replaceChildren();
  elements["query-result-title"].textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}${metadata.truncated ? " (limited)" : ""}`;
  elements["query-timing"].textContent = `${metadata.duration.toFixed(1)} ms${metadata.limit ? ` \u00b7 max ${metadata.limit}` : ""}`;
  if (!rows.length) {
    elements["query-results"].append(
      createElement("div", { className: "empty-state compact" }, [
        createElement("h3", { text: "No matching rows" }),
        createElement("p", { text: "The query completed successfully without results." }),
      ]),
    );
    return;
  }
  rows.forEach((row, index) => {
    elements["query-results"].append(
      createElement("div", { className: "result-item" }, [
        createElement("span", { className: "result-index", text: index + 1 }),
        renderWireTree(row),
      ]),
    );
  });
}

function activatePanel(panelId) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.panel === panelId;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const active = panel.id === panelId;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  if (panelId === "structure-panel" && app.selectedCollection && !app.schema?.statisticsIncluded) {
    renderStructure();
    loadSchema(app.selectionVersion, { details: true });
  }
  if (panelId === "diagnostics-panel" && app.selectedDatabaseId && !app.diagnostics) loadDiagnostics();
}

function selectedWriteOperation() {
  return document.querySelector('input[name="write-operation"]:checked')?.value || "insert";
}

function updateWriteOperation() {
  const operation = selectedWriteOperation();
  const needsId = operation !== "insert";
  elements["document-id-field"].hidden = !needsId;
  const label = operation === "insert" ? "Insert document" : operation === "replace" ? "Replace document" : "Update document";
  elements["write-heading"].textContent = label;
  elements["submit-document"].textContent = label;
  elements["write-rule"].textContent = operation === "update"
    ? "Update deep-merges a root object into the stored document."
    : operation === "replace"
      ? "Replace accepts object or scalar roots; root arrays are insert-only."
      : "Insert accepts object, array, or scalar roots.";
  validateDocumentEditor();
}

function resetDocumentEditor() {
  app.editTarget = null;
  elements["document-editor"].value = "{\n  \n}";
  elements["document-id"].value = "";
  const insert = document.querySelector('input[name="write-operation"][value="insert"]');
  if (insert) insert.checked = true;
  updateWriteOperation();
  validateDocumentEditor();
}

function validateDocumentEditor() {
  try {
    const wire = parseFriendlyJson(elements["document-editor"].value || "{}", "Document");
    const operation = selectedWriteOperation();
    if (operation === "update" && wire[0] !== "object") {
      throw new Error("An update payload must be a root object for deep merge.");
    }
    if (operation === "replace" && wire[0] === "array") {
      throw new Error("Root arrays cannot be replaced by the current node-idb command API; insert a new array document instead.");
    }
    elements["editor-validation"].textContent = "Valid typed JSON";
    elements["editor-validation"].classList.add("is-valid");
    elements["editor-validation"].classList.remove("is-invalid");
    return true;
  } catch (error) {
    elements["editor-validation"].textContent = errorMessage(error);
    elements["editor-validation"].classList.add("is-invalid");
    elements["editor-validation"].classList.remove("is-valid");
    return false;
  }
}

function beginEdit(row) {
  if (!app.state?.writable) return;
  app.editTarget = {
    databaseId: app.selectedDatabaseId,
    collection: app.selectedCollection,
    objectId: row.objectId,
  };
  elements["document-editor"].value = wireToEditorText(row.document);
  elements["document-id"].value = row.objectId;
  const replace = document.querySelector('input[name="write-operation"][value="replace"]');
  if (replace) replace.checked = true;
  updateWriteOperation();
  validateDocumentEditor();
  activatePanel("write-panel");
  elements["document-editor"].focus();
}

async function submitDocument() {
  if (!app.state?.writable || !app.selectedDatabaseId || !app.selectedCollection) {
    toast("Write unavailable", "Select a collection in a writable Studio session.", "error");
    return;
  }
  const operation = selectedWriteOperation();
  const objectId = Number(elements["document-id"].value);
  if (operation !== "insert" && (!Number.isSafeInteger(objectId) || objectId < 1)) {
    toast("Object ID required", "Replace and update need a positive integer object ID.", "error");
    elements["document-id"].focus();
    return;
  }
  if (
    operation !== "insert" &&
    app.editTarget &&
    (
      app.editTarget.databaseId !== app.selectedDatabaseId ||
      app.editTarget.collection !== app.selectedCollection ||
      app.editTarget.objectId !== objectId
    )
  ) {
    toast("Edit target changed", "Reset the editor and choose the document again before saving.", "error");
    return;
  }
  let documentWire;
  try {
    documentWire = parseFriendlyJson(elements["document-editor"].value, "Document");
    if (operation === "update" && documentWire[0] !== "object") {
      throw new Error("An update payload must be a root object for deep merge.");
    }
    if (operation === "replace" && documentWire[0] === "array") {
      throw new Error("Root arrays cannot be replaced by the current node-idb command API; insert a new array document instead.");
    }
  } catch (error) {
    validateDocumentEditor();
    toast("Invalid document", errorMessage(error), "error");
    return;
  }
  const body = {
    databaseId: app.selectedDatabaseId,
    collection: app.selectedCollection,
    document: documentWire,
  };
  if (operation !== "insert") body.objectId = objectId;
  setButtonBusy(elements["submit-document"], true, "Saving\u2026");
  try {
    await api(`/api/documents/${operation}`, { method: "POST", body });
    toast("Document saved", `${operation[0].toUpperCase()}${operation.slice(1)} completed successfully.`);
    await loadDocuments();
    if (operation === "insert") resetDocumentEditor();
  } catch (error) {
    toast("Write failed", errorMessage(error), "error");
  } finally {
    setButtonBusy(elements["submit-document"], false);
    updateWriteOperation();
  }
}

function insertTypeTemplate(template) {
  const editor = elements["document-editor"];
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const prefix = editor.value.slice(0, start);
  const suffix = editor.value.slice(end);
  editor.value = `${prefix}${template}${suffix}`;
  editor.focus();
  editor.setSelectionRange(start, start + template.length);
  validateDocumentEditor();
}

function requestDelete(row) {
  app.pendingDelete = {
    databaseId: app.selectedDatabaseId,
    collection: app.selectedCollection,
    objectId: row.objectId,
  };
  elements["delete-message"].textContent = `Document ${row.objectId} will be permanently removed from ${app.selectedCollection}.`;
  elements["delete-dialog"].showModal();
}

async function performDelete() {
  const target = app.pendingDelete;
  app.pendingDelete = null;
  if (!target || !app.state?.writable) return;
  try {
    await api("/api/documents/delete", {
      method: "POST",
      body: {
        databaseId: target.databaseId,
        collection: target.collection,
        objectId: target.objectId,
        confirm: true,
      },
    });
    toast("Document deleted", `Object ${target.objectId} was removed from ${target.collection}.`);
    if (
      app.selectedDatabaseId === target.databaseId &&
      app.selectedCollection === target.collection
    ) await loadDocuments();
  } catch (error) {
    toast("Delete failed", errorMessage(error), "error");
  }
}

function flattenObject(value, prefix = "", target = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return target;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) flattenObject(item, path, target);
    else target[path] = item;
  }
  return target;
}

function findMetric(flat, patterns) {
  const entries = Object.entries(flat);
  for (const pattern of patterns) {
    const found = entries.find(([key]) => key.toLocaleLowerCase().endsWith(pattern.toLocaleLowerCase()));
    if (found) return found[1];
  }
  return null;
}

function formatMetric(value, kind) {
  if (value === null || value === undefined) return "\u2014";
  if (kind === "bytes" && Number.isFinite(Number(value))) {
    const bytes = Number(value);
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }
  if (typeof value === "number") return new Intl.NumberFormat().format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function renderDiagnostics(report) {
  elements["diagnostics-json"].textContent = JSON.stringify(report, null, 2);
  elements["diagnostic-metrics"].replaceChildren();
  const flat = flattenObject(report);
  const engine = report?.engine || {};
  const storage = report?.storage || {};
  const metrics = [
    ["Collections", Array.isArray(engine.collections) ? engine.collections.length : getSelectedDatabase()?.collections.length, "count"],
    ["Storage size", storage.fileBytes ?? findMetric(flat, ["totalBytes", "storageBytes"]), "bytes"],
    ["Reclaimable", storage.reclaimableBytes, "bytes"],
    ["Open collections", engine.cache?.open, "count"],
    ["Cache evictions", engine.cache?.evictions, "count"],
    ["Active operations", engine.operations?.active, "count"],
    ["Schema version", engine.schemaVersion, "text"],
    ["Engine mode", engine.mode, "text"],
  ];
  for (const [label, value, kind] of metrics) {
    elements["diagnostic-metrics"].append(
      createElement("article", { className: "metric-card" }, [
        createElement("span", { text: label }),
        createElement("strong", { text: formatMetric(value, kind) }),
        createElement("small", { text: value === null || value === undefined ? "Not reported" : "Current session" }),
      ]),
    );
  }
}

async function loadDiagnostics() {
  if (!app.selectedDatabaseId) {
    toast("Choose a database", "Diagnostics need a selected database.", "error");
    return;
  }
  const databaseId = app.selectedDatabaseId;
  const selectionVersion = app.selectionVersion;
  setButtonBusy(elements["load-diagnostics"], true, "Loading\u2026");
  try {
    const payload = unwrapPayload(await api(`/api/databases/${encodeURIComponent(databaseId)}/diagnostics`));
    if (selectionVersion !== app.selectionVersion || databaseId !== app.selectedDatabaseId) return;
    app.diagnostics = payload || {};
    renderDiagnostics(app.diagnostics);
  } catch (error) {
    toast("Diagnostics failed", errorMessage(error), "error");
  } finally {
    setButtonBusy(elements["load-diagnostics"], false);
  }
}

async function runMaintenance(endpoint, button, label) {
  if (!app.state?.writable || !app.selectedDatabaseId) return;
  const databaseId = app.selectedDatabaseId;
  const selectionVersion = app.selectionVersion;
  setButtonBusy(button, true, "Working\u2026");
  try {
    await api(`/api/databases/${encodeURIComponent(databaseId)}/${endpoint}`, { method: "POST", body: {} });
    toast(`${label} complete`, "Database diagnostics were refreshed.");
    if (selectionVersion === app.selectionVersion && databaseId === app.selectedDatabaseId) {
      await loadDiagnostics();
    }
  } catch (error) {
    toast(`${label} failed`, errorMessage(error), "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function attachEvents() {
  elements["refresh-button"].addEventListener("click", refreshDiscovery);
  elements["navigator-filter"].addEventListener("input", renderNavigator);
  elements["reload-documents"].addEventListener("click", loadDocuments);
  elements["reload-structure"].addEventListener("click", () => loadSchema(app.selectionVersion, { details: true }));
  elements["structure-tree-mode"].addEventListener("click", () => setStructureView("tree"));
  elements["structure-list-mode"].addEventListener("click", () => setStructureView("list"));
  elements["page-size"].addEventListener("change", () => {
    app.page = 0;
    loadDocuments();
  });
  elements["document-order"].addEventListener("change", () => {
    app.page = 0;
    loadDocuments();
  });
  elements["previous-page"].addEventListener("click", () => {
    if (app.page > 0) {
      app.page -= 1;
      loadDocuments();
    }
  });
  elements["next-page"].addEventListener("click", () => {
    if (app.hasMore) {
      app.page += 1;
      loadDocuments();
    }
  });

  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => activatePanel(tab.dataset.panel));
  elements["parameters-help"].addEventListener("click", () => {
    const show = elements["parameters-guide"].hidden;
    elements["parameters-guide"].hidden = !show;
    elements["parameters-help"].setAttribute("aria-expanded", String(show));
  });
  elements["format-query"].addEventListener("click", () => {
    elements["query-editor"].value = formatQueryText(elements["query-editor"].value);
  });
  elements["run-query"].addEventListener("click", runQuery);
  elements["build-query"].addEventListener("click", buildQuery);
  elements["reset-builder"].addEventListener("click", resetBuilder);
  elements["builder-operator"].addEventListener("change", () => {
    elements["builder-value"].disabled = ["IS NULL", "IS NOT NULL"].includes(elements["builder-operator"].value);
  });

  for (const radio of document.querySelectorAll('input[name="write-operation"]')) radio.addEventListener("change", updateWriteOperation);
  elements["reset-document-editor"].addEventListener("click", resetDocumentEditor);
  elements["document-editor"].addEventListener("input", validateDocumentEditor);
  elements["submit-document"].addEventListener("click", submitDocument);
  for (const button of document.querySelectorAll("[data-type-template]")) {
    button.addEventListener("click", () => insertTypeTemplate(button.dataset.typeTemplate));
  }
  elements["delete-dialog"].addEventListener("close", () => {
    if (elements["delete-dialog"].returnValue === "confirm") performDelete();
    else app.pendingDelete = null;
  });

  elements["load-diagnostics"].addEventListener("click", loadDiagnostics);
  elements["analyze-database"].addEventListener("click", () => runMaintenance("analyze", elements["analyze-database"], "Analyze"));
  elements["optimize-indexes"].addEventListener("click", () => runMaintenance("optimize-indexes", elements["optimize-indexes"], "Index optimization"));
  elements["copy-diagnostics"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements["diagnostics-json"].textContent);
      toast("Diagnostics copied");
    } catch {
      toast("Copy unavailable", "Select the raw JSON and copy it manually.", "error");
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "/" && !editing) {
      event.preventDefault();
      elements["navigator-filter"].focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && document.getElementById("query-panel").classList.contains("is-active")) {
      event.preventDefault();
      runQuery();
    }
  });
}

attachEvents();
resetDocumentEditor();
loadState();
