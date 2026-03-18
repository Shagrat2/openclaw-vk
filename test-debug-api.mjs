import { VK } from "vk-io";

const TOKEN = process.env.VK_TOKEN;
if (!TOKEN) {
  console.error("Set VK_TOKEN");
  process.exit(1);
}

const vk = new VK({ token: TOKEN, apiLimit: 20 });

console.log("=== Test 1: groups.getById ===");
try {
  const r = await vk.api.groups.getById({});
  console.log("Response type:", typeof r);
  console.log("Response:", JSON.stringify(r, null, 2));
} catch (e) {
  console.error("Error:", e.message);
  // Try raw fetch as fallback
  console.log("\n=== Fallback: raw fetch ===");
  const resp = await fetch(
    `https://api.vk.com/method/groups.getById?v=5.199&access_token=${TOKEN}`,
  );
  const data = await resp.json();
  console.log("Raw response:", JSON.stringify(data, null, 2));
}

console.log("\n=== Test 2: Long Poll (3s) ===");
try {
  let started = false;
  vk.updates.on("message_new", (ctx) => {
    console.log(`Message from ${ctx.senderId}: "${ctx.text}"`);
  });

  await vk.updates.start();
  started = true;
  console.log("Long poll started OK");

  await new Promise((r) => setTimeout(r, 3000));
  await vk.updates.stop();
  console.log("Long poll stopped OK");
} catch (e) {
  console.error("Long poll error:", e.message);
}

console.log("\nDone.");
process.exit(0);
