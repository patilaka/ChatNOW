const SALT = new TextEncoder().encode('chatwave-salt-2026');
const ITERATIONS = 100_000;
const KEY_LENGTH = 256;

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Derive the AES key for a room.
 * `version` 0 = legacy salt (pre-rotation messages), 1+ = `chatrix-kv-<version>` salt.
 */
export async function deriveKey(roomCode: string, version: number = 0): Promise<CryptoKey> {
  const salt = version <= 0
    ? SALT
    : new TextEncoder().encode(`chatrix-kv-${version}`);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(roomCode),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(
  plaintext: string,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  return {
    ciphertext: bufferToBase64(encrypted),
    iv: bufferToBase64(iv.buffer),
  };
}

export async function decrypt(
  ciphertext: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    key,
    base64ToBuffer(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Derive an AES key from a user-supplied backup password.
 * The random salt is stored with the backup so restore can re-derive the key.
 */
export async function derivePasswordKey(password: string, salt: BufferSource): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Room safety fingerprint ("message DNA"): 12 hex chars from SHA-256 of the
 * room code, formatted like a safety number, e.g. "A1B2-C3D4-E5F6".
 */
export async function roomFingerprint(roomCode: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`chatrix-room:${roomCode}`)
  );
  const bytes = new Uint8Array(digest).slice(0, 6);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}
