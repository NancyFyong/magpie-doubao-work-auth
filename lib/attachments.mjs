/**
 * 长文本附件上传。
 *
 * 豆包 /chat/completion 单次请求有 262,144 字符硬上限。当 prompt 超过
 * INLINE_LIMIT 字节时，把完整历史与工具定义序列化成 .md 文件，经 TOS
 * （prepare_upload → ApplyImageUpload → PUT → CommitImageUpload → register）
 * 上传为豆包附件（block_type: 10052, source: long_text_paste），inline 只留
 * 轻量摘要。对话结束时自动删除附件，不会污染豆包的文件库。
 *
 * 移植自 tianpeng-dev/opencode-doubao-work-auth (MIT)，感谢原作者的实现思路。
 * 主机白名单扩展：豆包 TOS 实际返回 snssdk.com / douyin.com / vodupload.com，
 * 三个域名都在验证范围内。
 */
import { createHash, randomUUID } from 'node:crypto'
import aws4 from 'aws4'
import CRC32 from 'crc-32'
import { ProviderError, upstreamError } from './errors.mjs'

/** 超过此字节数走附件路径（留 2K 裕量确保低于 262,144 字符） */
export const INLINE_LIMIT = 260_000

/** 验证 TOS 上传主机（防 SSRF） */
function validateUploadHost(hostname) {
  if (!/^[a-z0-9.-]+\.(vodupload\.com|snssdk\.com|douyin\.com)$/i.test(hostname)) {
    throw new ProviderError('豆包附件上传主机不在已验证的范围内。', 502, 'invalid_upload_host')
  }
}

/**
 * 调用豆包的 TOS ImageX API（AWS4-HMAC-SHA256 签名）。
 * 使用 aws4 包签名，与 tianpeng 原始实现一致。
 */
async function imagexRequest(session, token, action, params, body, signal) {
  const url = new URL('/top/v1', 'https://www.doubao.com')
  url.search = new URLSearchParams({
    Action: action,
    Version: '2018-08-01',
    ServiceId: token.service_id,
    ...params,
  }).toString()

  const payload = body === undefined ? undefined : JSON.stringify(body)
  const signed = aws4.sign({
    host: url.host,
    path: url.pathname + url.search,
    method: payload ? 'POST' : 'GET',
    service: 'imagex',
    region: 'cn-north-1',
    body: payload,
    headers: payload
      ? { 'Content-Type': 'application/json', 'X-Amz-Content-Sha256': createHash('sha256').update(payload).digest('hex') }
      : {},
    extraHeadersToIgnore: { host: true, 'content-type': true, 'content-length': true },
  }, {
    accessKeyId: token.upload_auth_token.access_key,
    secretAccessKey: token.upload_auth_token.secret_key,
    sessionToken: token.upload_auth_token.session_token,
  })

  const resp = await fetch(url, {
    method: signed.method,
    redirect: 'error',
    signal,
    headers: {
      ...signed.headers,
      Cookie: session.jar.headerFor(url.href),
      Origin: 'https://www.doubao.com',
      Referer: 'https://www.doubao.com/',
    },
    ...(payload ? { body: payload } : {}),
  })
  const data = await resp.json()
  if (data.ResponseMetadata?.Error) {
    const e = data.ResponseMetadata.Error
    throw upstreamError({ code: e.Code, message: `${action}：${e.Message}` }, resp.ok ? 502 : resp.status)
  }
  if (!resp.ok || !data.Result) throw new ProviderError(`附件 ${action} 响应无效（HTTP ${resp.status}）。`, 502, 'invalid_attachment_response')
  return data.Result
}

/**
 * 获取 TOS 上传凭据。
 * scene_id=154 是豆包工作长文本粘贴专用的场景，无需 a_bogus 签名。
 */
export async function prepareUpload(session, signal) {
  const resp = await session.request('/alice/resource/prepare_upload', { tenant_id: '5', scene_id: '154', resource_type: 1 }, signal)
  const data = await resp.json()
  if (data.code !== 0 || !data.data?.upload_auth_token) {
    throw new ProviderError('豆包附件上传凭据获取失败。', 502, 'prepare_upload_failed')
  }
  return data.data
}

/**
 * 把任意文本上传为豆包长文本附件，返回 block_type 10052 的 content_block。
 * addAttachment 回调（由 ConversationLease 提供）在上传前登记 URI，
 * 保证即使上传后进程崩溃也能在下次启动时补做删除。
 */
export async function uploadTextAttachment(session, text, localMessageId, { addAttachment }, signal, preparedToken) {
  const bytes = Buffer.from(text, 'utf8')
  const identifier = randomUUID()
  const name = `magpie-history-${identifier}.md`

  const token = preparedToken || await prepareUpload(session, signal)

  const applied = await imagexRequest(session, token, 'ApplyImageUpload', {
    FileSize: String(bytes.length), FileExtension: '.md', NeedFallback: 'true', s: randomUUID().replaceAll('-', ''),
  }, undefined, signal)

  const { StoreInfos: [store], UploadHosts: [uploadHost], SessionKey, UploadHeader } = applied.UploadAddress
  validateUploadHost(uploadHost)
  const uri = store.StoreUri

  await addAttachment(uri)

  const uploadUrl = new URL(`https://${uploadHost}/upload/v1/${uri}`)
  const checksum = (CRC32.buf(bytes) >>> 0).toString(16).padStart(8, '0')
  const putHeaders = new Headers(UploadHeader)
  putHeaders.delete('Cookie')
  putHeaders.set('Authorization', store.Auth)
  putHeaders.set('Content-CRC32', checksum)
  putHeaders.set('X-Storage-U', encodeURIComponent(session.uid))
  putHeaders.set('Content-Type', 'application/octet-stream')

  const putResp = await fetch(uploadUrl, { method: 'POST', redirect: 'error', signal, headers: putHeaders, body: bytes })
  const putResult = await putResp.json()
  if (!putResp.ok || putResult.code !== 2000) {
    throw upstreamError({ code: putResult.code, message: putResult.message || '豆包附件上传失败' }, putResp.ok ? 502 : putResp.status)
  }
  if (String(putResult.data?.crc32).toLowerCase() !== checksum) {
    throw new ProviderError('豆包附件上传校验和不匹配。', 502, 'attachment_checksum_mismatch')
  }

  const committed = await imagexRequest(session, token, 'CommitImageUpload', {}, { SessionKey }, signal)
  if (!committed.Results?.some((item) => item.Uri === uri && item.UriStatus === 2000)) {
    throw new ProviderError('豆包未确认本次附件上传完成。', 502, 'attachment_commit_failed')
  }

  const md5 = createHash('md5').update(bytes).digest('hex')
  const regResp = await session.request('/alice/resource/register', {
    tenant_id: '5', scene_id: '154',
    resource_list: [{ uri, resource_type: 1, meta: { file_meta: { file_name: name, size: bytes.length, md5, identifier, content_type: 'text/markdown', parse_extra: {} } } }],
    extra: JSON.stringify({ bot_id: session.bot, conversation_id: '', local_message_id: localMessageId }),
  }, signal)
  const regData = await regResp.json()
  if (regData.code !== 0 || !regData.data?.[uri]?.resource_id) {
    throw new ProviderError('豆包没有确认长文本附件注册成功。', 502, 'attachment_registration_failed')
  }

  return {
    block_type: 10052,
    block_id: randomUUID(),
    parent_id: '',
    content: {
      attachment_block: {
        attachments: [{
          type: 3, identifier,
          file: { uri, url: '', file_type: 0, name, size: bytes.length },
          parse_state: 0, review_state: 1, upload_status: 1, progress: 100,
          src: JSON.stringify({ source: 'long_text_paste', version: 1 }),
        }],
      },
      pc_event_block: '',
    },
    meta_info: [],
    extra_info: {},
    append_fields: [],
  }
}

/** 删除一批已上传的附件 URI */
export async function deleteAttachments(session, uris) {
  if (!uris?.length) return
  const resp = await session.request('/alice/resource/delete_files', { uris: uris.map((uri) => ({ uri, data_type: 'file' })) }, AbortSignal.timeout(30_000))
  const data = await resp.json()
  if (data.code !== 0) throw upstreamError(data)
}
