import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '../main/core/conversationStore.js'
import { readLocalProjects, writeLocalProjects } from '../main/core/projects.js'

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-conversation-order-'))
  try {
    const older = await store.createConversation({
      dirPath: root,
      title: 'older',
      sessionData: { anywhere_history: true, fullHistory: [], history: [], chat_show: [] }
    })
    const newer = await store.createConversation({
      dirPath: root,
      title: 'newer',
      sessionData: { anywhere_history: true, fullHistory: [], history: [], chat_show: [] }
    })
    const projects = await readLocalProjects(root)
    projects.conversations[older.descriptor.conversationId].updatedAt = '2020-01-02T00:00:00.000Z'
    projects.conversations[newer.descriptor.conversationId].updatedAt = '2020-01-01T00:00:00.000Z'
    await writeLocalProjects(root, projects)
    const olderFileTime = new Date('2020-01-01T00:00:00.000Z')
    const recent = new Date('2020-01-03T00:00:00.000Z')
    await fs.utimes(older.databasePath, olderFileTime, olderFileTime)
    await fs.utimes(newer.databasePath, recent, recent)

    const listed = await store.listLocalConversations(root)
    assert.equal(listed[0].conversationId, newer.descriptor.conversationId)
    assert.equal(listed[0].updatedAt, recent.toISOString())
    console.log('PASS conversation order uses newest database activity')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
