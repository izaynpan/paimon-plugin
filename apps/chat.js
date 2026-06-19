import plugin from "../../../lib/plugins/plugin.js"
import { paimonRuntime, paimonLog } from "../lib/paimon-runtime.js"

export class PaimonChat extends plugin {
  constructor() {
    super({
      name: "派蒙聊天",
      dsc: "带用户长期记忆的 DeepSeek 对话机器人",
      event: "message",
      priority: 99999,
      rule: [{ reg: "", fnc: "chat", log: false }],
    })
  }

  async init() {
    try {
      await paimonRuntime.initialize()
    } catch (error) {
      paimonLog("error", "paimon-plugin 初始化失败", error)
      return "return"
    }
  }

  async chat(e) {
    return paimonRuntime.handleEvent(e)
  }
}
