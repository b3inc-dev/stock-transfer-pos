import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCustomerSearchQuery, normalizeCustomerSearch } from '../extensions/common/customerSearch.js';
test('customer lookup accepts one character, full Japanese names and both phone formats', () => {
  assert.match(buildCustomerSearchQuery('山'), /last_name:"山"\*/);
  assert.match(buildCustomerSearchQuery('山田太郎'), /last_name:"山田"\* AND first_name:"太郎"\*/);
  assert.match(buildCustomerSearchQuery('090-1234-5678'), /phone:"09012345678"\* OR phone:"\+819012345678"\*/);
  assert.match(buildCustomerSearchQuery('+81 90-1234-5678'), /phone:"09012345678"\*/);
  assert.equal(normalizeCustomerSearch('　山田　太郎　'), '山田 太郎');
  assert.equal(normalizeCustomerSearch('x'.repeat(150)).length, 100);
  assert.equal(buildCustomerSearchQuery(' '), '');
});
test('customer lookup quotes staff input instead of interpreting query operators', () => {
  const query = buildCustomerSearchQuery('name:"x"');
  assert.ok(query.includes('first_name:"name:\\"x\\""*'));
});
