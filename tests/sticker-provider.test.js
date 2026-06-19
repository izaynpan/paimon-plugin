import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { maybeSendSticker } from "../lib/sticker-provider.js"

test("表情包按情绪和概率发送，并拒绝插件目录外路径", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-sticker-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const image = path.join(root, "data", "stickers", "happy", "001.jpg")
  await fs.mkdir(path.dirname(image), { recursive: true })
  await fs.writeFile(image, "image")
  const sent = []
  const e = {
    reply: async value => {
      sent.push(value)
      return { message_id: "1" }
    },
  }
  const config = { stickers: { enabled: true, probability: 1 } }
  assert.equal(
    await maybeSendSticker({
      e,
      emotion: "happy",
      config,
      stickers: { happy: ["data/stickers/happy/001.jpg"] },
      root,
      random: () => 0,
      imageFactory: file => ({ file }),
    }),
    true,
  )
  assert.equal(sent[0].file, image)

  assert.equal(
    await maybeSendSticker({
      e,
      emotion: "happy",
      config,
      stickers: { happy: ["../outside.jpg"] },
      root,
      random: () => 0,
    }),
    false,
  )
  assert.equal(sent.length, 1)
})
