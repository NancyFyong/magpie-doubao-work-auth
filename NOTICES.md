# Third-party Notices

This project is a fork of [miaocell/magpie-doubao-work-auth](https://github.com/miaocell/magpie-doubao-work-auth) (MIT License, Copyright (c) 2026 Doubao Work Magpie plugin contributors). All original logic for authentication, model discovery, streaming, quota reporting, check-in, and conversation cleanup is preserved from the upstream project. Thank you to the original authors.

The long-text attachment upload implementation in `lib/attachments.mjs` is ported from [tianpeng-dev/opencode-doubao-work-auth](https://github.com/tianpeng-dev/opencode-doubao-work-auth) (MIT License, Copyright (c) 2026 Doubao Work Magpie plugin contributors). This includes the TOS upload flow (prepare_upload → ApplyImageUpload → PUT → CommitImageUpload → register) and the approach of serializing large contexts into a `.md` attachment to bypass the upstream 262,144-character single-message limit. Thank you to the original author.

Both upstream projects are released under the MIT License. This fork is also released under the MIT License.

## Changes in this fork

- Added `lib/attachments.mjs`: long-text attachment upload via TOS, with AWS4-HMAC-SHA256 signing (no extra npm dependencies), CRC32 integrity check, host allowlist for `vodupload.com`, `snssdk.com`, and `douyin.com`.
- Modified `lib/protocol.mjs`: when the serialized prompt exceeds 260,000 UTF-8 bytes, the full history and tool schemas are moved into the attachment; a lightweight inline summary is sent instead.
- Modified `lib/chat.mjs`: prefetches the upload token in parallel with model catalog fetching; uploads the attachment inside `session.exclusive()` before the `/chat/completion` call.
- Modified `lib/lease.mjs`: added `addAttachment(uri)` to persist attachment URIs in the lease record and `deleteAttachments` call in `finish()` for cleanup.
- Fixed `lib/models.mjs`: `EFFORT_NAMES` comment clarified (levels 6/7 were already present in upstream, confirmed they remain).
