import { PaimonChat } from "./apps/chat.js"
import { PaimonCommandObserver, PaimonCommandSuggestion } from './apps/commands.js'
import { PaimonNews } from './apps/news.js'

export const apps = { chat: PaimonChat, commandObserver: PaimonCommandObserver, commandSuggestion: PaimonCommandSuggestion, news: PaimonNews }
