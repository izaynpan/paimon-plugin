import { PaimonChat } from "./apps/chat.js"
import { PaimonCommandObserver, PaimonCommandSuggestion } from './apps/commands.js'

export const apps = { chat: PaimonChat, commandObserver: PaimonCommandObserver, commandSuggestion: PaimonCommandSuggestion }
