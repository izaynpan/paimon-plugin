import { PaimonChat } from "./apps/chat.js"
import { PaimonCommandObserver, PaimonCommandSuggestion } from './apps/commands.js'
import { PaimonNews } from './apps/news.js'
import { PaimonSrGacha } from './apps/sr-gacha.js'

export const apps = { chat: PaimonChat, commandObserver: PaimonCommandObserver, commandSuggestion: PaimonCommandSuggestion, news: PaimonNews, srGacha: PaimonSrGacha }
