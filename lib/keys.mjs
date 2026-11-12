// 设备身份（双因子里的"密钥"那一半）
//
// 设计：
// - 手机本地生成 ed25519 密钥对，**只上传公钥**，私钥永不出手机
// - 电脑端保存"信任的公钥列表"；一旦非空，后续请求必须「密码会话 + 私钥签名会话」同时成立
// - 换域名 / 用户主动换密钥 → 电脑端清空信任列表，只接受新配对
//
// 签名会话：手机用私钥签一个服务端一次性 nonce，换取短期 cookie（12h），避免每个请求都签名。

import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'

export function newKeyId() {
  return randomBytes(8).toString('hex')
}

/** 手机端：生成密钥对（PEM） */
export function generateIdentity(label = '') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    keyId: newKeyId(),
    label,
    createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** 手机端：签名（base64） */
export function signText(privateKeyPem, text) {
  return cryptoSign(null, Buffer.from(text, 'utf8'), privateKeyPem).toString('base64')
}

/** 电脑端：验签 */
export function verifyText(publicKeyPem, text, signatureBase64) {
  try {
    return cryptoVerify(null, Buffer.from(text, 'utf8'), publicKeyPem, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** 公钥指纹（给用户看，避免乱贴公钥） */
export function fingerprint(publicKeyPem) {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

/** 只看是不是合法的 ed25519 公钥 */
export function isValidPublicKey(publicKeyPem) {
  try {
    if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) return false
    const key = createPublicKey(publicKeyPem)
    return key.asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

/** 会话 cookie 的签名（HMAC） */
export function issueSessionToken(secret, keyId, ttlMs) {
  const payload = { k: keyId, e: Date.now() + ttlMs }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function readSessionToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expect = createHmac('sha256', secret).update(body).digest('base64url')
  if (mac !== expect) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload || typeof payload.e !== 'number' || payload.e < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
