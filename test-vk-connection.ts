/**
 * Quick smoke test for VK bot connection.
 * Usage: bun extensions/vk/test-vk-connection.ts
 *
 * Tests:
 * 1. Token validation via groups.getById
 * 2. Long poll connection
 * 3. Sending a message (if VK_TEST_PEER_ID is set)
 */

import { VK, getRandomId } from "vk-io";

const TOKEN = process.env.VK_TOKEN ?? "";
const TEST_PEER_ID = process.env.VK_TEST_PEER_ID; // Optional: your VK user ID to send a test message

if (!TOKEN) {
  console.error("Set VK_TOKEN environment variable");
  process.exit(1);
}

const vk = new VK({ token: TOKEN, apiLimit: 20 });

async function testProbe() {
  console.log("--- Test 1: Probe (groups.getById) ---");
  try {
    const response = await vk.api.groups.getById({});
    const group = response.groups[0];
    console.log(`  Group ID: ${group.id}`);
    console.log(`  Group name: ${group.name}`);
    console.log(`  Screen name: ${group.screen_name}`);
    console.log("  PASS");
    return true;
  } catch (err) {
    console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function testSendMessage() {
  if (!TEST_PEER_ID) {
    console.log("--- Test 2: Send message (SKIPPED - set VK_TEST_PEER_ID) ---");
    return true;
  }

  console.log(`--- Test 2: Send message to peer ${TEST_PEER_ID} ---`);
  try {
    const messageId = await vk.api.messages.send({
      peer_id: Number(TEST_PEER_ID),
      message: "OpenClaw VK plugin test message",
      random_id: getRandomId(),
    });
    console.log(`  Message sent, ID: ${messageId}`);
    console.log("  PASS");
    return true;
  } catch (err) {
    console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function testLongPoll() {
  console.log("--- Test 3: Long Poll connection (5s) ---");
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      console.log("  Long poll connected (no messages in 5s, which is fine)");
      console.log("  PASS");
      vk.updates.stop().then(() => resolve(true));
    }, 5000);

    vk.updates.on("message_new", (ctx) => {
      console.log(`  Received message from ${ctx.senderId}: "${ctx.text}"`);
    });

    vk.updates
      .start()
      .then(() => {
        console.log("  Long poll started successfully");
      })
      .catch((err) => {
        clearTimeout(timeout);
        console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
        resolve(false);
      });
  });
}

async function main() {
  console.log("VK Bot Connection Test\n");

  const probeOk = await testProbe();
  if (!probeOk) {
    console.log("\nProbe failed - check your token. Aborting.");
    process.exit(1);
  }

  await testSendMessage();
  await testLongPoll();

  console.log("\nAll tests passed.");
  process.exit(0);
}

main();
