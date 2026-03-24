import { createClient } from "redis";

const globalForRedis = globalThis as unknown as { redis?: ReturnType<typeof createClient> };

function getClient() {
  if (!globalForRedis.redis) {
    globalForRedis.redis = createClient({ url: process.env.REDIS_URL });
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
