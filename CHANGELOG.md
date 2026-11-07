# Changelog

## 0.1.0

- The **Valkey Vector Store** node: Insert Documents, Get Many, Retrieve as Vector Store and Retrieve as Tool, storing documents as Valkey hashes without TEXT fields.
- The **Valkey API** credential (host, port, username, password, TLS, Cluster Mode, database number) with a connection test.
- Standalone and cluster-mode servers: enable **Cluster Mode** in the credential to connect with a cluster client.
- Metadata fields indexed as TAG or NUMERIC, with a Metadata Filter in the retrieve modes.
- Delete Index and Documents option that drops the index and deletes its documents before inserting.
- Update Documents mode, which replaces the document with a given ID with a newly embedded one, or creates it if none exists (an upsert by ID); and an ID Metadata Field option that applies the same by-ID behaviour to Insert, storing each document under the ID from the named metadata field instead of a random one so re-inserting the same ID overwrites it rather than adding a duplicate.