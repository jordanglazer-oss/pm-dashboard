// In-memory RESP2 stand-in for Redis (local testing only; holds no real data).
import net from "node:net";

const store = new Map();
const bulk = (v) => (v == null ? "$-1\r\n" : "$" + Buffer.byteLength(v) + "\r\n" + v + "\r\n");
const arr = (items) => "*" + items.length + "\r\n" + items.join("");

function matches(pattern, key) {
  // Only the "prefix*" and "*" forms are used by the app.
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

function run(a) {
  const c = a[0].toUpperCase();
  if (c === "GET") return bulk(store.get(a[1]));
  if (c === "SET") {
    const nx = a.slice(3).some((x) => x.toUpperCase() === "NX");
    if (nx && store.has(a[1])) return "$-1\r\n";
    store.set(a[1], a[2]);
    return "+OK\r\n";
  }
  if (c === "DEL") {
    let n = 0;
    for (const k of a.slice(1)) if (store.delete(k)) n++;
    return ":" + n + "\r\n";
  }
  if (c === "INCR") {
    const n = Number(store.get(a[1]) ?? 0) + 1;
    store.set(a[1], String(n));
    return ":" + n + "\r\n";
  }
  if (c === "INCRBYFLOAT") {
    const n = Number(store.get(a[1]) ?? 0) + Number(a[2]);
    store.set(a[1], String(n));
    return bulk(String(n));
  }
  if (c === "EXPIRE") return ":1\r\n";
  if (c === "MGET") return arr(a.slice(1).map((k) => bulk(store.get(k))));
  if (c === "SCAN") {
    const mi = a.findIndex((x) => x.toUpperCase() === "MATCH");
    const pat = mi > 0 ? a[mi + 1] : "*";
    const keys = [...store.keys()].filter((k) => matches(pat, k));
    return arr([bulk("0"), arr(keys.map(bulk))]);
  }
  if (c === "PING") return "+PONG\r\n";
  return "+OK\r\n";
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length === 0 || buf[0] !== 42) break;
      const p = buf.indexOf("\r\n");
      if (p < 0) break;
      const n = Number(buf.subarray(1, p).toString());
      let o = p + 2;
      const args = [];
      let complete = true;
      for (let i = 0; i < n; i++) {
        const q = buf.indexOf("\r\n", o);
        if (q < 0) { complete = false; break; }
        const len = Number(buf.subarray(o + 1, q).toString());
        if (buf.length < q + 2 + len + 2) { complete = false; break; }
        args.push(buf.subarray(q + 2, q + 2 + len).toString());
        o = q + 2 + len + 2;
      }
      if (!complete) break;
      buf = buf.subarray(o);
      sock.write(run(args));
    }
  });
  sock.on("error", () => {});
});

server.listen(6391, "127.0.0.1", () => console.log("redis stub on 6391"));
