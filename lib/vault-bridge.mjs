/**
 * 从 miaocell 保管库直接初始化会话（无需豆包工作桌面客户端）。
 * 返回 { profile, cookies, clientInfo, clientVersion }，交给 DesktopSession.load() 后由 Jar.from() 构建 jar。
 */
export function vaultImporter(saved) {
  return async () => ({
    profile: saved.profile || 'vault',
    cookies: saved.cookies,
    clientVersion: saved.clientVersion || '',
    clientInfo: {
      webId: String(saved.clientInfo?.webId || ''),
      deviceId: String(saved.clientInfo?.deviceId || ''),
      teaUuid: String(saved.clientInfo?.teaUuid || ''),
    },
  })
}
