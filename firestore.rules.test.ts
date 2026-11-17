import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesText = fs.readFileSync('firestore.rules', 'utf8');
const blueprint = JSON.parse(fs.readFileSync('firebase-blueprint.json', 'utf8'));

test('firestore.rules includes default-deny safety net and every blueprint collection', () => {
  assert.match(rulesText, /rules_version\s*=\s*'2'/);
  assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  for (const pathKey of Object.keys(blueprint.firestore)) {
    const collectionName = pathKey.split('/')[1];
    assert.match(rulesText, new RegExp(`match /${collectionName}/`));
  }
});

test('Dirty Dozen security gates exist in firestore.rules', () => {
  // 1 & 2: Admin check enforces verified email or /admins/{uid}
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesText, /exists\(\/databases\/\$\(database\)\/documents\/admins\/\$\(request\.auth\.uid\)\)/);

  // 3: Shadow field checks (hasOnly + affectedKeys)
  assert.match(rulesText, /data\.keys\(\)\.hasOnly\(/);
  assert.match(rulesText, /affectedKeys\(\)\.hasOnly\(/);

  // 4: ID regex guard
  assert.match(rulesText, /isValidId/);

  // 5: Bounded array & price check
  assert.match(rulesText, /data\.colors\.size\(\) <= 12/);

  // 6 & 7: Orders PII isolated to isAdmin() for get and list
  assert.match(rulesText, /match \/orders\/\{orderId\}[\s\S]*?allow get: if isAdmin\(\)/);
  assert.match(rulesText, /match \/orders\/\{orderId\}[\s\S]*?allow list: if isAdmin\(\)/);

  // 8, 9, 10, 11: Order create requires Pending, quantity <= 4, inStock product price match, and request.time
  assert.match(rulesText, /incoming\(\)\.status == 'Pending'/);
  assert.match(rulesText, /data\.quantity >= 1 && data\.quantity <= 4/);
  assert.match(rulesText, /data\.inStock == true/);
  assert.match(rulesText, /incoming\(\)\.createdAt == request\.time/);

  // 12: Self-assigned admin write blocked
  assert.match(rulesText, /match \/admins\/\{userId\}[\s\S]*?allow list, create, update, delete: if false;/);
});
