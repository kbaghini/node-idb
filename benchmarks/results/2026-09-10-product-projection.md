# Product card projections

Run `node benchmarks/product-projection.js` from the repository root.
[Raw measurements](2026-09-10-product-projection.json) ·
[Runnable storefront example](../../examples/18-product-cards.js)

Windows, Node.js 24.11.1, Intel Core i9-13900H. Each workload seeds 1,000
products in fresh temporary disk storage, then reads the first 25 products.
Products have SKU, name, price, thumbnail URL, numeric stock, a description and
nested specifications. Descriptions are either 128 or 16,384 ASCII characters.
Both paths use identical ordering and limits with existing cache defaults and
optional field indexes disabled. Three rounds alternate comparison order,
with five warmup reads and 30 timed reads per mode in each round. Every page's
five card fields are checked for equality outside the timed section.

## Results

Median cumulative times for 30 page reads (750 returned products):

| Description length | Mode | Database read time | JSON serialization time |
| --- | --- | ---: | ---: |
| 128 characters | Full documents | 114.15 ms | 0.90 ms |
| 128 characters | Five card fields | 78.62 ms | 1.24 ms |
| 16,384 characters | Full documents | 117.60 ms | 18.05 ms |
| 16,384 characters | Five card fields | 70.99 ms | 1.25 ms |

Read time includes node-idb query processing and result reconstruction. The
large-document projection reduced it by about 40% (1.66x throughput). The small
serialization measurements show no benefit and are sensitive to timer/GC noise.

Response sizes for one 25-product page:

| Description length | Full JSON | Projected JSON | Full gzip | Projected gzip |
| --- | ---: | ---: | ---: | ---: |
| 128 characters | 7,105 bytes | 2,570 bytes | 754 bytes | 468 bytes |
| 16,384 characters | 413,505 bytes | 2,570 bytes | 2,257 bytes | 468 bytes |

The large fixture saves about 99.4% of uncompressed JSON bytes, but about 79.3%
after gzip. Descriptions deliberately repeat a sentence and compress extremely
well; these ratios are fixture-specific. The projection also contains node-idb's
automatic `object_id` identity, whereas full documents retain their original
shape. This overhead is included in the projected byte counts.

These are warm sequential reads, not concurrent-store capacity measurements.
No HTTP request, browser rendering, image download, TLS or network time is
measured. Gzip sizes are measured once per sample using Node's default gzip;
gzip processing time is not part of serialization timing. RSS/peak memory is
not measured. All values here are ordinary JSON-safe strings and numbers;
typed values such as BigInt or binary need an appropriate application codec.

## Recommended application pattern

Read only the scalar fields needed for product cards. Load the complete document
for a product detail view when requested. Keep access, visibility and tenant
filters identical in both paths. Projections do not enforce authorization.

This uses existing node-idb functionality; no engine, storage-format, default
query behavior, or Studio document-inspection behavior was changed. Full reads
remain appropriate when the application actually needs the complete document.
