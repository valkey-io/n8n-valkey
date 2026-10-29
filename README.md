# Valkey Vector Store for n8n

An n8n community node that uses [Valkey](https://valkey.io/) with the ValkeySearch module as a vector store for AI workflows: semantic search, retrieval-augmented generation (RAG) and agent tools.

n8n's Redis Vector Store node does not work with Valkey because it creates `TEXT` index fields, which ValkeySearch rejects (`Unknown argument 'TEXT'`, [n8n issue #21361](https://github.com/n8n-io/n8n/issues/21361)). This node stores documents without any `TEXT` field. It is built on [`@langchain/valkey`](https://github.com/valkey-io/langchainjs-valkey).

- [Installation](#installation)
- [Requirements and limitations](#requirements-and-limitations)
- [Credentials](#credentials)
- [Operation modes](#operation-modes)
- [Options](#options)
- [Metadata fields and filtering](#metadata-fields-and-filtering)
- [Document IDs and Update](#document-ids-and-update)
- [Errors](#errors)
- [Setup: self-hosted Valkey](#setup-self-hosted-valkey)
- [Setup: AWS ElastiCache for Valkey](#setup-aws-elasticache-for-valkey)
- [Troubleshooting](#troubleshooting)

## Installation

Self-hosted n8n only. In n8n, go to **Settings > Community Nodes > Install** and enter `n8n-nodes-valkey-vector-store`. See the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

The package depends on `@valkey/valkey-glide`, which ships a native binary. Prebuilt binaries exist for Linux x64 and arm64 (glibc and musl, which covers the `n8nio/n8n` Docker image) and macOS. **Windows is not supported**: the node does not load on n8n installed with npm on Windows. Because of the runtime dependencies, the package is not eligible for n8n Cloud verification.

## Requirements and limitations

- Valkey 8.2 or later with the ValkeySearch module, for example the `valkey/valkey-bundle` image or ElastiCache for Valkey.
- **Standalone only.** Cluster-mode servers, including ElastiCache with cluster mode enabled, are rejected with an error.
- **HASH storage only.** Each document is a Valkey hash. Indexes created `ON JSON` are rejected.
- **No TEXT fields and no full-text search.** Only the vector is indexed by default; metadata can be indexed as TAG or NUMERIC.

## Credentials

Create a **Valkey API** credential:

| Field | Default | Notes |
|---|---|---|
| Host | | Required |
| Port | 6379 | |
| Username | | ACL user. Empty uses the default user. |
| Password | | Stored as a secret |
| SSL/TLS | off | Required for ElastiCache with in-transit encryption |
| Database Number | 0 | |

**Test connection** connects with these settings, runs `PING`, and shows the server's error if it fails. It times out after a few seconds rather than hanging, for example when the server needs TLS and TLS is off.

## Operation modes

| Mode | What it does |
|---|---|
| Insert Documents | Embeds documents from a Document Loader with the connected Embeddings node and stores them. Creates the index if it does not exist. |
| Get Many | Similarity search for a prompt; outputs the closest documents with content, metadata (including the document ID) and score. |
| Retrieve Documents (As Vector Store for Chain/Tool) | Connects the store to a retriever or chain. |
| Retrieve Documents (As Tool for AI Agent) | Exposes the store as a tool the agent calls with a query. |
| Update Documents | Replaces the document with the given ID with a newly embedded one, or creates it if there is none. See [Document IDs and Update](#document-ids-and-update). |

## Options

These **Index Options** must be the same in every node that uses an index:

| Option | Default | Description |
|---|---|---|
| Key Prefix | `doc:<index name>:` | Keys the documents are stored under. The index covers this prefix. |
| Content Key | `content` | Hash field holding the document text |
| Metadata Key | `metadata` | Hash field holding the metadata as JSON |
| Vector Key | `content_vector` | Hash field holding the embedding |
| Distance Metric | Cosine | Cosine, Euclidean (L2) or Inner Product (IP) |
| ID Metadata Field | empty (random IDs) | Metadata field whose value is each document's ID. See [Document IDs and Update](#document-ids-and-update). |

**Insert Options:**

| Option | Default | Description |
|---|---|---|
| Vector Algorithm | HNSW | HNSW or FLAT. Only used when the index is created. |
| TTL (Seconds) | 0 (never) | Expire each inserted document |
| Delete Index and Documents | off | Delete the index **and all of its documents** (every key under the prefix the index was built with), then insert. **Permanently deletes data.** This happens once per run, after the first batch has been embedded, so an embeddings failure leaves the old data intact. If the insert fails after the delete, the old data is not restored. If the delete itself fails partway (for example a lost connection), the index is kept and the error says how many keys were deleted; run the node again to finish. |

The vector dimension is taken from the connected Embeddings model when the index is created.

The index schema is fixed when the index is created. To change it (another embeddings model, metric or metadata fields), use **Delete Index and Documents**, or a new index name and key prefix.

### Using Delete Index and Documents safely

- **Use it only on indexes this node created.** It deletes every key under the index's key prefixes, whatever type the key is or whichever application wrote it. An index made by another tool can cover other kinds of keys, such as JSON documents, and all of them are deleted.
- **Give each workflow its own index name and key prefix.** If two workflows share them, a document inserted by one while the other is running Delete Index and Documents can be left behind without an index, and the other run can recreate the index between the delete and the drop.
- **Do not leave it on in a workflow that adds documents over time.** It runs on every execution and replaces the index's contents each time.

## Metadata fields and filtering

Every document's metadata is stored and returned with results. To **filter** on a field, declare it in **Metadata Fields to Index** on the Insert node before the index is created:

- **TAG**: exact match on strings or arrays of strings, for example `source`, `tenant`.
- **NUMERIC**: number ranges, for example `year`, `page`.

Only top-level metadata keys can be indexed.

When inserting into an existing index, the node writes every TAG and NUMERIC field defined by that index, regardless of the fields listed in **Metadata Fields to Index**. Documents added later therefore remain filterable on all indexed fields. Each field listed in **Metadata Fields to Index** must exist in the index with the same type; otherwise, the insert fails.

In the retrieve modes, **Metadata Filter** lists the index's TAG and NUMERIC fields. Conditions are combined with AND:

| Field type | Operators |
|---|---|
| TAG | is, is any of (comma-separated values) |
| NUMERIC | equals, greater than or equal, less than or equal, between (inclusive) |

Values accept expressions, for example `{{ $json.customerId }}`. In **Retrieve as Tool** mode the filter comes only from the node configuration; the agent cannot change it, which makes it suitable for tenant isolation.

If you set **Field** with an expression, return the field name (`source`) or the dropdown's value form (`source|TAG`). The field and operator are always checked against the index when the node runs.

## Document IDs and Update

By default each document gets a random ID, so inserting the same content twice stores it twice. Search results (Get Many, and the retrieve modes) return the stored metadata only; a random ID is not included. To update documents by ID, set **ID Metadata Field** so the ID is part of the stored metadata, for example `{{ $json.document.metadata.doc_key }}`. Insert's output does not include random IDs, because n8n builds it before the IDs are created.

To use your own IDs, add the ID to each document's metadata in the Document Loader, for example `doc_key` = `{{ $json.faq_number }}`, and set **ID Metadata Field** in Index Options to `doc_key`. Then:

- Each document is stored under the Key Prefix plus its ID, for example `doc:my-docs:faq-1`. An ID that already starts with the Key Prefix is used as is.
- **Inserting an existing ID replaces that document** instead of adding a copy, so a workflow can be re-run to refresh its documents.
- Each document needs a unique, non-empty string or number ID. `1` and `"1"` are the same ID; IDs are not trimmed. A missing or repeated ID stops the insert. A text splitter makes several chunks with the same ID, so don't use one with this option.
- Turning the option on for an existing index leaves its documents with random IDs as they are; only new inserts use the metadata ID.

**Update Documents** writes one document per input item under the given ID (an upsert):

- **Content** is the text of the updated document, by default `{{ $json.text }}`. It is embedded and replaces the old content. Other fields of the input item are not stored.
- **Options > Metadata** sets the updated document's metadata as name/value pairs, for example `tenant` = `{{ $json.tenant }}`. n8n also adds its own `source` and `blobType` fields.
- The document is replaced whole: metadata fields you don't list are removed, including fields used in metadata filters. To keep a field, list it, for example with its value from a Get Many result: `{{ $('Get Many').item.json.document.metadata.tenant }}`.
- If no document has that ID, the update creates one under it, so check the ID: a typo adds a new document instead of failing. The index itself must already exist.
- With ID Metadata Field set, a missing ID field is filled in with the Update ID, and a different value stops the update.
- **TTL (Seconds)** under **Options** in Update mode sets the updated document's expiry. Its previous expiry is not kept, so leave it at 0 for no expiry, or set the same value as on insert.
- Update works without ID Metadata Field too, with a random ID taken from a Get Many result.

## Errors

The node stops with an error instead of returning partial or empty results when something is wrong. Among others:

- The index does not exist (retrieve modes).
- The existing index does not match the node: JSON storage, another key prefix, vector key, distance metric or dimension, or a declared metadata field missing.
- A filter names a field that is not indexed, uses an operator for the wrong type, or has a non-numeric NUMERIC value.
- A document's metadata does not match a declared field type.
- With ID Metadata Field set: a document's ID is missing, empty or repeated in one run.
- Update: the ID is empty, or the ID field in the new metadata differs from it. Content is empty or not text, or an Options > Metadata field has no name, surrounding spaces, or appears twice.
- The Document Loader produced no documents.
- An insert failed partway; the error says how many documents were already written, and whether the index had been cleared.
- Server errors (timeouts, authentication, ACL permissions) are shown as the server reported them.

## Setup: self-hosted Valkey

Run Valkey with ValkeySearch, bound to localhost:

```bash
docker run -d --name valkey -p 127.0.0.1:6379:6379 valkey/valkey-bundle:latest
```

If n8n runs in Docker too, put both containers on one network and use the Valkey container name as the host. Set a password (`--requirepass` or an ACL user) for anything beyond local testing.

In n8n, create a Valkey API credential with host `localhost`, port `6379`, then build a workflow: **Default Data Loader** + an **Embeddings** node → **Valkey Vector Store** (Insert Documents).

## Setup: AWS ElastiCache for Valkey

1. Create an ElastiCache for Valkey cache (8.2 or later) with **cluster mode disabled**. Serverless caches and cluster-mode-enabled clusters are not supported.
2. Enable **in-transit encryption** and set up authentication (an ElastiCache RBAC user or AUTH token).
3. Run n8n in the same VPC (or a peered network), and allow inbound TCP 6379 from n8n in the cache's security group. ElastiCache is not reachable from the internet.
4. Create a Valkey API credential: host = the cache's **primary endpoint**, port `6379`, SSL/TLS **on**, and the username and password from step 2.

## Troubleshooting

| Error | Cause |
|---|---|
| `The ValkeySearch module is not available on this server` | The server runs Valkey without ValkeySearch, for example the plain `valkey/valkey` image. Use `valkey/valkey-bundle` or ElastiCache for Valkey 8.2+. |
| `Cluster mode is not supported` | The server has cluster mode enabled. Use a standalone server. |
| `Index "…" has vector dimension X, but the connected embeddings produce Y` | The Embeddings model differs from the one the index was built with. |
| Connection test times out | Check the host, port, security groups, and whether the server requires TLS. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the pre-commit hook.

## Resources

- [n8n community nodes](https://docs.n8n.io/integrations/#community-nodes)
- [Valkey Search](https://valkey.io/topics/search/)
- [`@langchain/valkey`](https://github.com/valkey-io/langchainjs-valkey)

## Version history

See [CHANGELOG.md](CHANGELOG.md).
