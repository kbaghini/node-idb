# Cursor pagination measurements

Run `node benchmarks/cursor-pages.js`. [Raw measurements](2026-09-10-cursor-pages.json).

100,000 small products on temporary local disk, Node.js 24.11.1, Intel Core
i9-13900H. Three alternating comparison rounds, five warmup reads and 30 measured
reads per round. Both queries use node-idb and return the same 25 object IDs;
every result is checked. Median elapsed times for 30 reads:

| Rows before page | OFFSET | Cursor |
| --- | ---: | ---: |
| 25 | 34.68 ms | 40.30 ms |
| 50,000 | 73.04 ms | 45.17 ms |
| 99,975 | 64.76 ms | 25.49 ms |

The final page's ID selection was about 2.54x faster in this workload. Early
pages showed no benefit; measurements include ordinary scheduling variability.
These are warm sequential core ID-selection measurements, excluding HTTP,
document hydration and UI rendering. The benchmark precomputes each anchor
outside the timed section; real sequential navigation obtains it from the
previous page. It does not make arbitrary page-number jumps constant-time.

Studio additionally avoids COUNT on cursor requests and fetches limit+1 IDs to
derive hasMore, then hydrates only the requested page. This separate saving is
not included in the comparison above. Offset requests retain their old counts.
Both modes are live reads, not multi-page snapshots. Cursor predicates use the
last returned ID even if that record has subsequently been deleted. The UI
retains earlier page boundaries for Previous; changes in data can alter what
those pages contain. Sorting by a different field requires an appropriate
composite boundary and a separately validated query plan.
