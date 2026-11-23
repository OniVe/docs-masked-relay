#!/usr/bin/env node
/**
 * Helpers for the self-hosted CRX build. Uses only Node's built-in crypto so
 * the build does not depend on OpenSSL being installed.
 *
 *   node extension-id.mjs keygen <key.pem>   create an RSA-2048 PKCS#8 key
 *   node extension-id.mjs id <key.pem>       extension ID derived from the key
 *   node extension-id.mjs crx-id <file.crx>  ID derived from the CRX public key
 *
 * Chrome/Edge extension IDs are the first 16 bytes of SHA-256 over the
 * DER-encoded SubjectPublicKeyInfo, with every hex nibble mapped 0-f -> a-p.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function idFromSpkiDer(der) {
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

function loadPrivateKey(path) {
  if (!existsSync(path)) {
    fail(`key file not found: ${path}`);
  }
  try {
    return createPrivateKey(readFileSync(path));
  } catch (error) {
    fail(`cannot read RSA private key ${path}: ${error.message}`);
  }
}

function publicKeyDer(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
}

function readVarint(buffer, cursor) {
  let value = 0;
  let shift = 0;
  while (cursor.pos < buffer.length) {
    const byte = buffer[cursor.pos];
    cursor.pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
    if (shift > 49) {
      fail('malformed CRX header: varint too long');
    }
  }
  fail('malformed CRX header: truncated varint');
}

/** Minimal protobuf field reader; enough for CrxFileHeader. */
function readFields(buffer) {
  const fields = [];
  const cursor = { pos: 0 };
  while (cursor.pos < buffer.length) {
    const tag = readVarint(buffer, cursor);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      fields.push({ field, wire, value: readVarint(buffer, cursor) });
    } else if (wire === 2) {
      const length = readVarint(buffer, cursor);
      if (cursor.pos + length > buffer.length) {
        fail('malformed CRX header: truncated field');
      }
      fields.push({
        field,
        wire,
        value: buffer.subarray(cursor.pos, cursor.pos + length),
      });
      cursor.pos += length;
    } else if (wire === 1) {
      cursor.pos += 8;
      fields.push({ field, wire, value: null });
    } else if (wire === 5) {
      cursor.pos += 4;
      fields.push({ field, wire, value: null });
    } else {
      fail(`malformed CRX header: unsupported wire type ${wire}`);
    }
    if (cursor.pos > buffer.length) {
      fail('malformed CRX header: field exceeds header');
    }
  }
  return fields;
}

function crxPublicKeyDer(crxPath) {
  const crx = readFileSync(crxPath);
  if (crx.length < 13) {
    fail('malformed CRX: file is too short');
  }
  if (crx.toString('ascii', 0, 4) !== 'Cr24') {
    fail('malformed CRX: missing Cr24 magic');
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) {
    fail(`unsupported CRX version ${version}; expected 3`);
  }
  const headerSize = crx.readUInt32LE(8);
  if (headerSize === 0 || 12 + headerSize >= crx.length) {
    fail(`malformed CRX: invalid header size ${headerSize}`);
  }

  const header = crx.subarray(12, 12 + headerSize);
  const topLevel = readFields(header);

  // CrxFileHeader.sha256_with_rsa = 2 (repeated AsymmetricKeyProof).
  const rsaProof = topLevel.find((entry) => entry.field === 2 && entry.wire === 2);
  if (!rsaProof) {
    fail('malformed CRX: no RSA signature proof in header');
  }
  // AsymmetricKeyProof.public_key = 1 (bytes, DER SubjectPublicKeyInfo).
  const proofFields = readFields(rsaProof.value);
  const publicKey = proofFields.find((entry) => entry.field === 1 && entry.wire === 2);
  if (!publicKey || publicKey.value.length === 0) {
    fail('malformed CRX: RSA proof has no public key');
  }
  return publicKey.value;
}

const [command, target] = process.argv.slice(2);
if (!command || !target) {
  console.error('usage: node extension-id.mjs <keygen|id|crx-id> <path>');
  process.exit(2);
}

const path = resolve(target);

if (command === 'keygen') {
  if (existsSync(path)) {
    fail(`refusing to overwrite existing key: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // flag "wx" makes the create-if-absent check atomic.
  writeFileSync(path, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log(idFromSpkiDer(publicKeyDer(createPrivateKey(privateKey))));
} else if (command === 'id') {
  console.log(idFromSpkiDer(publicKeyDer(loadPrivateKey(path))));
} else if (command === 'crx-id') {
  if (!existsSync(path)) {
    fail(`CRX file not found: ${path}`);
  }
  console.log(idFromSpkiDer(crxPublicKeyDer(path)));
} else {
  fail(`unknown command: ${command}`);
}
