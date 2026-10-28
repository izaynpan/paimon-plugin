import { KnowledgeStore } from '../lib/knowledge/store.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export async function main(args = process.argv.slice(2), store = new KnowledgeStore()) {
  const [command, argument] = args
  if (command === 'build') {
    const result = await store.build({ activate: !args.includes('--no-activate'), characters: args.includes('--characters') ? true : args.includes('--lore-only') ? false : undefined })
    console.log(JSON.stringify({ revision: result.revision, files: result.sources.length, chunks: result.chunks.length,
      characters: result.characters ? { profiles: result.characters.profiles.length, chunks: result.characters.chunks.length } : null,
      active: !args.includes('--no-activate'), warnings: result.warnings }, null, 2))
  } else if (command === 'rollback') console.log(JSON.stringify(await store.rollback(argument), null, 2))
  else if (command === 'status') {
    const { index, issue } = await store.load()
    console.log(JSON.stringify({ revision: index.snapshot.revision, sources: index.snapshot.sources, chunks: index.documents.length,
      characters: index.snapshot.characters ? { profiles: index.snapshot.characters.profiles, chunks: index.snapshot.characters.chunks.length, aliasConflicts: index.registry.conflicts } : null, issue }, null, 2))
  } else if (command === 'query') {
    const { index, issue } = await store.load()
    const result = index.search({ query: args.slice(1).filter(a => a !== '--lore-only').join(' ') }, { characters: Boolean(index.characters) && !args.includes('--lore-only') })
    console.log(JSON.stringify({ revision: index.snapshot.revision, issue, diagnostics: result.diagnostics, matches: result.matches.map(m => ({
      id: m.id, file: m.file, headingPath: m.headingPath, lineStart: m.lineStart, score: m.score, text: m.text })) }, null, 2))
  } else throw new Error('Usage: node scripts/knowledge.js build [--characters|--lore-only] [--no-activate] | status | query <text> [--lore-only] | rollback [revision]')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
