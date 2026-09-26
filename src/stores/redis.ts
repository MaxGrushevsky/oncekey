import type { Redis as RedisClient } from "ioredis";
import type {
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResponse,
} from "../types.js";

export type RedisStoreOptions = {
  /** ioredis client (or compatible). */
  redis: RedisClient;
  /** Key prefix. Default: oncekey: */
  prefix?: string;
};

/**
 * Redis-backed store for multi-instance deployments.
 *
 * Records are Redis hashes. Claim/complete/abandon run as Lua scripts that
 * only use redis.call (no cjson), so they work with real Redis and ioredis-mock.
 *
 * ```ts
 * import Redis from "ioredis";
 * import { Idempotency } from "oncekey";
 * import { RedisStore } from "oncekey/redis";
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const store = new RedisStore({ redis });
 * ```
 */
export class RedisStore implements IdempotencyStore {
  private readonly redis: RedisClient;
  private readonly prefix: string;

  constructor(options: RedisStoreOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? "oncekey:";
  }

  private key(storageKey: string): string {
    return `${this.prefix}${storageKey}`;
  }

  async claim(input: {
    storageKey: string;
    fingerprint: string;
    now: number;
    ttlMs: number;
    leaseMs: number;
  }): Promise<ClaimResult> {
    const redisKey = this.key(input.storageKey);
    const result = (await this.redis.eval(
      CLAIM_LUA,
      1,
      redisKey,
      input.fingerprint,
      String(input.now),
      String(input.ttlMs),
      String(input.leaseMs),
    )) as string[];

    const kind = result[0];
    if (kind === "acquired") {
      return { kind: "acquired" };
    }

    const record = hashToRecord(input.storageKey, result.slice(1));
    if (kind === "replay") return { kind: "replay", record };
    if (kind === "mismatch") return { kind: "mismatch", record };
    return { kind: "in_progress", record };
  }

  async complete(input: {
    storageKey: string;
    fingerprint: string;
    response: StoredResponse;
    now: number;
    ttlMs: number;
  }): Promise<void> {
    await this.redis.eval(
      COMPLETE_LUA,
      1,
      this.key(input.storageKey),
      input.fingerprint,
      JSON.stringify(input.response),
      String(input.now),
      String(input.ttlMs),
    );
  }

  async abandon(input: {
    storageKey: string;
    fingerprint: string;
  }): Promise<void> {
    await this.redis.eval(
      ABANDON_LUA,
      1,
      this.key(input.storageKey),
      input.fingerprint,
    );
  }

  async get(storageKey: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.hgetall(this.key(storageKey));
    if (!raw || Object.keys(raw).length === 0) return null;
    return hashToRecord(storageKey, flattenHash(raw));
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }
}

function flattenHash(raw: Record<string, string>): string[] {
  return [
    raw.fingerprint ?? "",
    raw.status ?? "",
    raw.response ?? "",
    raw.lockedAt ?? "0",
    raw.createdAt ?? "0",
    raw.updatedAt ?? "0",
    raw.expiresAt ?? "0",
  ];
}

function hashToRecord(
  storageKey: string,
  fields: string[],
): IdempotencyRecord {
  const [
    fingerprint = "",
    status = "processing",
    responseRaw = "",
    lockedAt = "0",
    createdAt = "0",
    updatedAt = "0",
    expiresAt = "0",
  ] = fields;

  let response: StoredResponse | null = null;
  if (responseRaw) {
    response = JSON.parse(responseRaw) as StoredResponse;
  }

  return {
    storageKey,
    fingerprint,
    status: status as IdempotencyRecord["status"],
    response,
    lockedAt: Number(lockedAt),
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
    expiresAt: Number(expiresAt),
  };
}

/**
 * Returns:
 *   { "acquired" }
 *   { "replay"|"mismatch"|"in_progress", fingerprint, status, response, lockedAt, createdAt, updatedAt, expiresAt }
 */
const CLAIM_LUA = `
local key = KEYS[1]
local fingerprint = ARGV[1]
local now = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])

local expiresAt = tonumber(redis.call('HGET', key, 'expiresAt') or '0')
if expiresAt > 0 and expiresAt <= now then
  redis.call('DEL', key)
end

local existingFp = redis.call('HGET', key, 'fingerprint')
if not existingFp then
  redis.call('HSET', key,
    'fingerprint', fingerprint,
    'status', 'processing',
    'response', '',
    'lockedAt', now,
    'createdAt', now,
    'updatedAt', now,
    'expiresAt', now + ttlMs
  )
  redis.call('PEXPIRE', key, ttlMs)
  return { 'acquired' }
end

local status = redis.call('HGET', key, 'status')
local response = redis.call('HGET', key, 'response') or ''
local lockedAt = redis.call('HGET', key, 'lockedAt') or '0'
local createdAt = redis.call('HGET', key, 'createdAt') or '0'
local updatedAt = redis.call('HGET', key, 'updatedAt') or '0'
local exp = redis.call('HGET', key, 'expiresAt') or '0'

if existingFp ~= fingerprint then
  return { 'mismatch', existingFp, status, response, lockedAt, createdAt, updatedAt, exp }
end

if status == 'completed' and response ~= '' then
  return { 'replay', existingFp, status, response, lockedAt, createdAt, updatedAt, exp }
end

if status == 'processing' and (tonumber(lockedAt) + leaseMs) <= now then
  redis.call('HSET', key,
    'fingerprint', fingerprint,
    'status', 'processing',
    'response', '',
    'lockedAt', now,
    'updatedAt', now,
    'expiresAt', now + ttlMs
  )
  redis.call('PEXPIRE', key, ttlMs)
  return { 'acquired' }
end

return { 'in_progress', existingFp, status, response, lockedAt, createdAt, updatedAt, exp }
`;

const COMPLETE_LUA = `
local key = KEYS[1]
local fingerprint = ARGV[1]
local responseJson = ARGV[2]
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local existingFp = redis.call('HGET', key, 'fingerprint')
if not existingFp then return 0 end
if existingFp ~= fingerprint then return 0 end
local status = redis.call('HGET', key, 'status')
if status == 'completed' then return 0 end
redis.call('HSET', key,
  'status', 'completed',
  'response', responseJson,
  'updatedAt', now,
  'lockedAt', now,
  'expiresAt', now + ttlMs
)
redis.call('PEXPIRE', key, ttlMs)
return 1
`;

const ABANDON_LUA = `
local key = KEYS[1]
local fingerprint = ARGV[1]
local existingFp = redis.call('HGET', key, 'fingerprint')
if not existingFp then return 0 end
if existingFp ~= fingerprint then return 0 end
local status = redis.call('HGET', key, 'status')
if status == 'completed' then return 0 end
redis.call('DEL', key)
return 1
`;
