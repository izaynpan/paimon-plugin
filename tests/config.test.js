import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PaimonConfig } from "../lib/config.js"

test("配置深合并、环境变量优先并支持热重载", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-config-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "config")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "default.yaml"),
    JSON.stringify({
      enabled: true,
      deepseek: {
        apiKey: "file-key",
        apiKeyEnv: "TEST_DEEPSEEK_KEY",
        model: "deepseek-v4-flash",
        timeoutMs: 60000,
      },
      persona: { file: "persona.md" },
      stickers: { configFile: "stickers.yaml" },
    }),
  )
  await fs.writeFile(
    path.join(dir, "config.yaml"),
    JSON.stringify({ deepseek: { timeoutMs: 1234 } }),
  )
  await fs.writeFile(path.join(dir, "persona.md"), "测试人设")
  await fs.writeFile(path.join(dir, "stickers.yaml"), JSON.stringify({ happy: ["a.jpg"] }))

  let changeHandler
  let closed = false
  const watcher = {
    on(event, handler) {
      if (event === "change") changeHandler = handler
      return this
    },
    async close() {
      closed = true
    },
  }
  const config = new PaimonConfig({
    root,
    env: { TEST_DEEPSEEK_KEY: "env-key" },
    yamlParser: JSON.parse,
    watcherFactory: () => watcher,
  })
  const loaded = await config.load()
  assert.equal(loaded.deepseek.model, "deepseek-v4-flash")
  assert.equal(loaded.deepseek.timeoutMs, 1234)
  assert.equal(loaded.deepseek.apiKey, "env-key")
  assert.equal(config.getPersona(), "测试人设")
  assert.deepEqual(config.getStickers(), { happy: ["a.jpg"] })

  await config.startWatching()
  await fs.writeFile(
    path.join(dir, "config.yaml"),
    JSON.stringify({ deepseek: { timeoutMs: 4321 } }),
  )
  await changeHandler()
  assert.equal((await config.load()).deepseek.timeoutMs, 4321)
  await config.close()
  assert.equal(closed, true)
})

test("用户配置不存在时从默认配置创建", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-config-create-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "config")
  await fs.mkdir(dir, { recursive: true })
  const defaults = {
    deepseek: { apiKey: "", apiKeyEnv: "NONE", model: "deepseek-v4-flash" },
    persona: { file: "persona.md" },
    stickers: { configFile: "stickers.yaml" },
  }
  await fs.writeFile(path.join(dir, "default.yaml"), JSON.stringify(defaults))
  await fs.writeFile(path.join(dir, "persona.md"), "人设")
  await fs.writeFile(path.join(dir, "stickers.yaml"), "{}")
  const config = new PaimonConfig({ root, env: {}, yamlParser: JSON.parse })
  await config.load()
  const created = JSON.parse(await fs.readFile(path.join(dir, "config.yaml"), "utf8"))
  assert.equal(created.deepseek.model, "deepseek-v4-flash")
})
