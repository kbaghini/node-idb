# Embed Studio in your web application

[Overview](../README.md) · [Studio guide](STUDIO.md) · [Runnable demo](../examples/embedded-studio/)

Embed mode displays Studio inside an iframe and delegates authentication to
your application's server. Studio still listens only on `127.0.0.1`; publish
its configured path through your application's HTTPS reverse proxy.

## Try the complete local demo

From a repository checkout or unpacked package with dependencies installed:

```bash
node examples/embedded-studio/index.js
```

Open the printed **web application** URL. The parent application issues an
HTTP-only demonstration cookie and proxies `/admin/studio/` to Studio. The iframe
uses that session with read-only access to `demo`; the seeded `private` database
does not appear and cannot be accessed through Studio's API.

This loopback-only example automatically creates a demo session. It is not a
production login system. Replace it with your verified application sessions.

## Configure the server

The following integration sketch assumes your application supplies
`sessions.verifyRequest()` and `permissions.forUser()`:

```js
import { startStudio } from "node-idb/studio";

const studio = await startStudio({
  rootPath: "/srv/my-app/databases",
  port: 4177,
  basePath: "/admin/studio/",
  writable: true, // Upper bound; each user's grant may still be read-only.
  embed: {
    publicOrigin: "https://app.example.com",
    allowedParents: ["https://app.example.com"],
    hideHeader: true,
    hideNavigator: false,
    async authenticate(request, { signal }) {
      const session = await sessions.verifyRequest(request, { signal });
      if (!session) return null;
      const access = await permissions.forUser(session.userId, { signal });
      return {
        subject: session.userId,
        databases: access.databaseDirectoryNames,
        writable: access.canManageDocuments,
      };
    },
  },
});
```

`authenticate` runs on every page, asset, and API request. It must verify a
session or credential before returning a grant. Never derive a grant directly
from a browser-supplied user ID, tenant ID, query parameter, or unsigned identity
header. Return `null` for missing, expired, or invalid authentication. There is
no fallback to the local launch token in embed mode.

`databases` contains exact immediate directory names under `rootPath`, such as
`["tenant-42"]`. Use `"."` only to grant the database directly in the root. No
wildcards or arbitrary paths are accepted. This list filters discovery and is
checked by every database endpoint, including query, diagnostics, comparison,
and import. A hidden navigator is only a layout preference; when hidden, the
first permitted collection is initially selected. Prefer one permitted
database for this layout.

Writes require both `writable: true` on the Studio instance and `writable: true`
in the current user's grant. Writes include document mutations and maintenance.
Preview tickets also belong to their authenticated subject. Concurrent requests
carry separate authorization contexts; grants are rechecked on later requests.
The configured timeout also bounds authentication. Already-running operations
are not retroactively revoked when your permissions store changes.

## Reverse proxy without stripping the prefix

For example, inside your existing HTTPS Nginx server configuration:

```nginx
location /admin/studio/ {
    proxy_pass http://127.0.0.1:4177;
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Node-Idb-Studio $http_x_node_idb_studio;
}
```

Keep the original `/admin/studio/` prefix. Do not add a trailing path slash to
`proxy_pass` that would strip it. Studio accepts only its configured public host
or its local listening host; forwarded-host/protocol headers do not configure
trust. Ensure the application session cookie is valid on this path and uses
your application's production cookie protections. Align proxy request-size and
timeout settings with Studio's limits.

## Add the iframe

```html
<iframe
  src="/admin/studio/"
  title="Database Studio"
  style="width: 100%; height: 80vh; border: 0"
></iframe>
```

Serving the host application and Studio on the same HTTPS origin is the
recommended integration: their existing session cookie can cover both paths.
`basePath` must start and end with `/`, using letters, digits, `_` and `-` in
its segments. Studio loads assets and APIs through that prefix.

`allowedParents` controls the response's CSP `frame-ancestors` policy. Exact
HTTPS origins are required; HTTP loopback origins are allowed for development.
Every ancestor must be permitted when frames are nested. Preserve Studio's CSP
at the proxy; a blanket `X-Frame-Options: DENY` added by the proxy would prevent
embedding. [CSP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)

An allowed parent is not an authentication grant or a CORS origin. Studio does
not enable cross-origin API access. Its UI sends a custom header on API
requests, and the server checks the public origin and request metadata to
reject cross-site mutations. A separate-origin iframe also needs a deliberate
cookie/session design and may encounter browser third-party cookie restrictions;
the included demo tests the same-origin deployment.

## Boundaries

- Local mode remains the default, with launch-token authentication and framing
  denied. `embed: false` explicitly selects it; `basePath` also works locally.
- `hideHeader` defaults to true. `hideNavigator` defaults to false. The local
  footer is hidden in embed mode.
- Shared managed backups are operator-only and disabled in embed mode, including
  direct API calls. Use a separate local Studio to manage backups. Embedded
  users can export permitted collections subject to transfer limits.
- Grants are per database, with read-only or write access. This version does not
  implement collection/field-level permissions, a login provider, or signed
  approval workflows. A read grant includes browsing, SELECT queries, diagnostics,
  comparison, export, and import preview for the permitted databases.
- The server-side `refresh()` handle has no end-user grant; obtain a user's
  filtered catalog through their authenticated HTTP `/api/state` request.
- There is no parent-window `postMessage` API in this version. Integration is
  through the configured session, path, permissions, and iframe layout.
