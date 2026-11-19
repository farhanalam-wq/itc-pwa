import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Collection, Db, Document } from 'mongodb';

const ADMIN_ID = 'primary';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

interface AdminDocument extends Document {
  _id: typeof ADMIN_ID;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionDocument extends Document {
  tokenHash: string;
  adminId: typeof ADMIN_ID;
  createdAt: Date;
  expiresAt: Date;
}

export interface AdminIdentity {
  id: typeof ADMIN_ID;
  email: string;
  displayName: string;
}

export interface AdminCredentials {
  email: string;
  password: string;
}

export interface AdminBootstrapInput extends AdminCredentials {
  setupToken: string;
  displayName: string;
}

export interface AdminSessionResult {
  admin: AdminIdentity;
  token: string;
}

export type AdminAuthFailure = 'setup_disabled' | 'admin_exists' | 'setup_token_invalid' | 'invalid_credentials';

export interface AdminAuthService {
  getStatus(): Promise<{ adminExists: boolean; setupEnabled: boolean }>;
  bootstrap(input: AdminBootstrapInput): Promise<{ ok: true; value: AdminSessionResult } | { ok: false; reason: AdminAuthFailure }>;
  login(input: AdminCredentials): Promise<AdminSessionResult | undefined>;
  getSession(token: string | undefined): Promise<AdminIdentity | undefined>;
  logout(token: string | undefined): Promise<void>;
  readonly cookieSecure: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase('en-US');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function identity(admin: AdminDocument): AdminIdentity {
  return { id: ADMIN_ID, email: admin.email, displayName: admin.displayName };
}

export class MongoAdminAuthService implements AdminAuthService {
  private readonly admins: Collection<AdminDocument>;
  private readonly sessions: Collection<SessionDocument>;
  readonly cookieSecure: boolean;

  constructor(
    database: Db,
    private readonly setupToken: string | undefined,
    options: { cookieSecure: boolean }
  ) {
    this.admins = database.collection<AdminDocument>('admins');
    this.sessions = database.collection<SessionDocument>('admin_sessions');
    this.cookieSecure = options.cookieSecure;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.admins.createIndex({ email: 1 }, { unique: true, name: 'admin_email_unique' }),
      this.sessions.createIndex({ tokenHash: 1 }, { unique: true, name: 'admin_session_hash_unique' }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'admin_session_ttl' }),
      this.sessions.createIndex({ adminId: 1, expiresAt: 1 }, { name: 'admin_session_lookup' })
    ]);
  }

  async getStatus(): Promise<{ adminExists: boolean; setupEnabled: boolean }> {
    const adminExists = Boolean(await this.admins.findOne({ _id: ADMIN_ID }, { projection: { _id: 1 } }));
    return { adminExists, setupEnabled: !adminExists && Boolean(this.setupToken) };
  }

  async bootstrap(input: AdminBootstrapInput): Promise<{ ok: true; value: AdminSessionResult } | { ok: false; reason: AdminAuthFailure }> {
    if (!this.setupToken) return { ok: false, reason: 'setup_disabled' };
    if (!matchesSecret(input.setupToken, this.setupToken)) return { ok: false, reason: 'setup_token_invalid' };
    if (await this.admins.findOne({ _id: ADMIN_ID }, { projection: { _id: 1 } })) {
      return { ok: false, reason: 'admin_exists' };
    }

    const now = new Date();
    const admin: AdminDocument = {
      _id: ADMIN_ID,
      email: normalizeEmail(input.email),
      displayName: input.displayName.trim(),
      passwordHash: await Bun.password.hash(input.password),
      createdAt: now,
      updatedAt: now
    };

    try {
      await this.admins.insertOne(admin);
    } catch (error) {
      if (isDuplicateKey(error)) return { ok: false, reason: 'admin_exists' };
      throw error;
    }

    return { ok: true, value: await this.createSession(admin) };
  }

  async login(input: AdminCredentials): Promise<AdminSessionResult | undefined> {
    const admin = await this.admins.findOne({ _id: ADMIN_ID, email: normalizeEmail(input.email) });
    if (!admin) return undefined;
    let valid = false;
    try {
      valid = await Bun.password.verify(input.password, admin.passwordHash);
    } catch {
      valid = false;
    }
    if (!valid) return undefined;
    return this.createSession(admin);
  }

  async getSession(token: string | undefined): Promise<AdminIdentity | undefined> {
    if (!token || token.length > 256) return undefined;
    const session = await this.sessions.findOne({ tokenHash: tokenHash(token), expiresAt: { $gt: new Date() } });
    if (!session || session.adminId !== ADMIN_ID) return undefined;
    const admin = await this.admins.findOne({ _id: ADMIN_ID });
    return admin ? identity(admin) : undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || token.length > 256) return;
    await this.sessions.deleteOne({ tokenHash: tokenHash(token), adminId: ADMIN_ID });
  }

  private async createSession(admin: AdminDocument): Promise<AdminSessionResult> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.sessions.insertOne({
      tokenHash: tokenHash(token),
      adminId: ADMIN_ID,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS)
    });
    return { admin: identity(admin), token };
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export function readAdminSetupToken(env: Record<string, string | undefined> = Bun.env): string | undefined {
  return env.ADMIN_SETUP_TOKEN?.trim() || undefined;
}

export function readManagerOrigin(env: Record<string, string | undefined> = Bun.env): string | undefined {
  const value = env.MANAGER_ORIGIN?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !localHttp) {
      throw new Error('MANAGER_ORIGIN must use HTTPS outside local development.');
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error('MANAGER_ORIGIN must contain only the origin, without a path or query.');
    }
    return url.origin;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MANAGER_ORIGIN')) throw error;
    throw new Error('MANAGER_ORIGIN must be a valid origin URL.');
  }
}

export function isAllowedManagerOrigin(request: Request, configuredOrigin: string | undefined): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  if (configuredOrigin) return normalized === configuredOrigin;
  try {
    return normalized === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function readAdminSessionToken(cookieHeader: string | null): string | undefined {
  for (const part of cookieHeader?.split(';') ?? []) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'itc_admin_session') continue;
    const token = rest.join('=');
    return token || undefined;
  }
  return undefined;
}

export const ADMIN_SESSION_COOKIE_NAME = 'itc_admin_session';
export const ADMIN_SESSION_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1000;
