import { createClient } from "redis";

const globalForRedis = globalThis as unknown as { redis?: ReturnType<typeof createClient> };

function getClient() {
  if (!globalForRedis.redis) {
    const url = process.env.REDIS_URL || process.env.KV_URL;
    if (!url) {
      console.error("No REDIS_URL or KV_URL environment variable set");
    }
    globalForRedis.redis = createClient({ url });
    globalForRedis.redis.on("error", (err) => console.error("Redis error:", err));
  }
  return globalForRedis.redis;
}

export async function getRedis() {
  const client = getClient();
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
