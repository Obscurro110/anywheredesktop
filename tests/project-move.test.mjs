import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createConversation } from '../main/core/conversationStore.js'
import { readLocalProjects, writeLocalProjects } from '../main/core/projects.js'

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anywhere-project-move-'))
  try {
    const created = await createConversation({
      dirPath: root,
      title: 'movable',
      sessionData: { anywhere_history: true, fullHistory: [], history: [], chat_show: [] }
    })
    const projects = await readLocalProjects(root)
    projects.projects.push({ id: 'target', name: 'Target', files: [], conversationIds: [] })
    await writeLocalProjects(root, projects)

    const saved = await readLocalProjects(root)
    const conversationId = created.descriptor.conversationId
    assert.equal(Boolean(saved.conversations[conversationId]), true)
    saved.projects = saved.projects.map((project) => project.id === 'target'
      ? { ...project, conversationIds: [conversationId] }
      : project)
    await writeLocalProjects(root, saved)

    const reloaded = await readLocalProjects(root)
    const target = reloaded.projects.find((project) => project.id === 'target')
    assert.deepEqual(target.conversationIds, [conversationId])
    console.log('PASS sqlite conversation project move survives reload')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
