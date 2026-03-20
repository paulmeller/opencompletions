#!/usr/bin/env node

const net = require("net");

const FROM_PORT = 80;
const TO_PORT = 3000;

const server = net.createServer((src) => {
  const dst = net.createConnection({ port: TO_PORT, host: "127.0.0.1" });
  src.pipe(dst);
  dst.pipe(src);
  src.on("error", () => dst.destroy());
  dst.on("error", () => src.destroy());
});

server.listen(FROM_PORT, "0.0.0.0", () => {
  console.log(`Port forwarder: 0.0.0.0:${FROM_PORT} -> 127.0.0.1:${TO_PORT}`);
});

server.on("error", (err) => {
  console.error(`Forwarder error: ${err.message}`);
  process.exit(1);
});
