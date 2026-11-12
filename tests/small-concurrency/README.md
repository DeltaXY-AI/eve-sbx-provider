# SBX-9 small concurrency

Executed by `../provider-contract/live.mjs` against the packed provider. Uses five simultaneously started sessions, asserts five distinct native VM names, writes 20 unique exact-byte files per VM, searches all 20 markers, reads all 100 files byte-for-byte, ends each provider session, and independently checks each assigned VM no longer exists. The same runner tests 20 concurrent command requests in one session VM with unique stdout/stderr and exit code `i % 5`.

Raw outputs and mappings are saved in each run's `five-session-mapping.json`, `parallel-20.json`, lifecycle log, and inventory files. This is a five-session workload only; it makes no 100-session capacity claim.
