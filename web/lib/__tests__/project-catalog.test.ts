import test from 'node:test'
import assert from 'node:assert/strict'
import { projectCatalogRequest } from '../project-catalog.ts'

test('embedded project requests use the host catalog even if standalone preferences are present', () => {
  assert.equal(projectCatalogRequest({ projectSource: 'openclaw' }), '/api/projects?detail=true')
  assert.equal(projectCatalogRequest({ projectSource: 'openclaw', devRoot: '/old/root' }), '/api/projects?detail=true')
})

test('standalone project discovery retains its configured root and setup state', () => {
  assert.equal(projectCatalogRequest({ devRoot: '/my projects' }), '/api/projects?root=%2Fmy%20projects&detail=true')
  assert.equal(projectCatalogRequest({}), null)
  assert.equal(projectCatalogRequest({ devRoot: null }), null)
})
