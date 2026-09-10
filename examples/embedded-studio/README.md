# Embedded Studio demo

From the repository root, run:

```sh
node examples/embedded-studio/index.js
```

Open the printed URL to see Studio inside an application iframe. The demo
creates sample data under `.example-data/embedded-studio`, issues a local demo
session, and permits read-only access to the `demo` database. The `private`
database is deliberately excluded.

The automatic demo session is not a production login. See the
[Embed guide](../../docs/EMBED.md) for real session integration, database grants,
HTTPS, and reverse proxy configuration.
