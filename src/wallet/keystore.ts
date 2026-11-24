import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

/**
 * Şifreli anahtar dosyası: scrypt (N=2^15) ile paroladan anahtar türetilir,
 * gizli anahtar AES-256-GCM ile şifrelenir. Dosya izni 0600.
 */
interface KeystoreFile {
  version: 1;
  publicKey: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}

const KDF = { N: 2 ** 15, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer, params = KDF) {
  return crypto.scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 128 * 1024 * 1024 });
}

export function encryptKeypair(kp: Keypair, passphrase: string): KeystoreFile {
  if (passphrase.length < 10) throw new Error('Parola en az 10 karakter olmalı');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(kp.secretKey)), c.final()]);
  return {
    version: 1,
    publicKey: kp.publicKey.toBase58(),
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') },
  };
}

export function decryptKeypair(file: KeystoreFile, passphrase: string): Keypair {
  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
  d.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
  let secret: Buffer;
  try {
    secret = Buffer.concat([d.update(Buffer.from(file.cipher.ciphertext, 'base64')), d.final()]);
  } catch {
    throw new Error('Parola yanlış ya da dosya bozuk');
  }
  const kp = Keypair.fromSecretKey(new Uint8Array(secret));
  secret.fill(0);
  if (kp.publicKey.toBase58() !== file.publicKey) throw new Error('Anahtar doğrulanamadı');
  return kp;
}

export function saveKeystore(filePath: string, kp: Keypair, passphrase: string) {
  if (fs.existsSync(filePath)) throw new Error(`Dosya zaten var, üzerine yazılmaz: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(encryptKeypair(kp, passphrase), null, 2), { mode: 0o600 });
}

export function loadKeystore(filePath: string, passphrase: string): Keypair {
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as KeystoreFile;
  return decryptKeypair(file, passphrase);
}

export function keystorePublicKey(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return (JSON.parse(fs.readFileSync(filePath, 'utf8')) as KeystoreFile).publicKey;
}

/** Terminalden gizli giriş (yazılan karakterler gösterilmez) */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('Parola girmek için interaktif terminal gerekli (ya da KEYSTORE_PASSPHRASE_FILE kullanın)');
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readPassphrase(fileOpt?: string): Promise<string> {
  if (fileOpt) return fs.readFileSync(fileOpt, 'utf8').trim();
  return promptHidden('Keystore parolası: ');
}
