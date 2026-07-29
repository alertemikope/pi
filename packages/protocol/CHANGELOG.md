# Changelog

## [Unreleased]

### Breaking Changes

- Replaced JSON wire messages with protocol version 2's transport-neutral, four-byte length-prefixed CBOR frames. `parseClientMessage()` and `parseServerMessage()` no longer parse JSON strings.

### Added

- Added strict RFC 8949 subset encoding, standalone byte-stream framing mechanics, complete validated message encoders, and incremental client/server message decoders with bounded input limits.
- Added the experimental versioned protocol, runtime schemas, snapshots, commands, transcript DTOs, and typed errors.
