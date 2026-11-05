# Valkey Vector Store for n8n

An n8n community node that uses [Valkey](https://valkey.io/) as a vector store.

## Scope

This node is for **self-hosted n8n users who want to use Valkey with the
[Valkey Search](https://valkey.io/topics/search/) module as a vector store** — storing
embeddings in Valkey and querying them from n8n's AI/LangChain nodes (Insert, retrieve, and
retrieve-as-tool workflows).

In scope:

- Connecting to a Valkey server (standalone or cluster mode) that has the Valkey Search module
  loaded, for example the `valkey/valkey-bundle` image.
- Storing documents as Valkey hashes and indexing metadata as TAG or NUMERIC fields for
  filtering.
- The self-hosted path with no cloud account required. Managed services that provide Valkey
  Search may be documented as clearly labeled optional sections.

Out of scope:

- Valkey servers without the Valkey Search module (the node needs `FT.*` commands).
- Full-text search and `TEXT` fields; only vector search with TAG/NUMERIC metadata filters is
  supported.
- Being a general-purpose Valkey client — this node is specifically a vector store for n8n.
- Vector stores other than Valkey, and non-n8n integrations.
