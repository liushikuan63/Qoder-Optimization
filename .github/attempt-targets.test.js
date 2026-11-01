'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { familyOf, keyOf } = require('../scripts/attempt-lock-core.js');

for (const [command, family] of [
  ['ssh host.example pytest', 'deploy'],
  ['ssh host.example "npm run build"', 'deploy'],
  ['node -e "console.log(123) // npm run build"', null],
  ['npm run show --label pytest', null],
  ['node --test --help', null],
  ['node --test --help=1', null],
  ['node --test --version=1', null],
  ['node --test -v', null],
  ['mvn -Dlabel=test compile', 'build'],
  ['gradle -Plabel=test assemble', 'build'],
  ['npm run build -- --label pytest', 'build'],
  ['docker compose up --label pytest', 'deploy'],
  ['systemctl restart pytest', 'deploy'],
  ['npm run test', 'test'], ['pnpm run e2e', 'test'],
  ['yarn build', 'build'], ['bun run build', 'build'],
  ['mvn -q test', 'test'], ['mvn clean verify', 'build'],
  ['gradle :app:test', 'test'], ['gradlew assemble', 'build'],
  ['cargo test', 'test'], ['cargo build', 'build'],
  ['go test ./...', 'test'], ['go build ./...', 'build'],
  ['dotnet test', 'test'], ['dotnet build', 'build'],
  ['npx -y vitest run', 'test'], ['python -m pytest tests/', 'test'],
  ['sudo systemctl restart app', 'deploy'], ['node --test tests/', 'test'],
]) {
  test('retry family belongs to the executed program: ' + command, () => {
    assert.equal(familyOf(command), family);
  });
}

test('argument text does not move a build into a different retry family', () => {
  assert.equal(keyOf('build', 'npm run build -- --label pytest', '/project'),
    keyOf('build', 'npm run build', '/project'));
});

test('remote operands beyond the first three tokens keep targets separate', () => {
  assert.notEqual(keyOf('deploy', 'ssh -o BatchMode=yes -o ConnectTimeout=2 host-a.example uptime', '/project'),
    keyOf('deploy', 'ssh -o BatchMode=yes -o ConnectTimeout=2 host-b.example uptime', '/project'));
});

test('remote verbosity flags do not reset an otherwise identical retry target', () => {
  assert.equal(keyOf('deploy', 'ssh -v host.example uptime', '/project'),
    keyOf('deploy', 'ssh -vvv host.example uptime', '/project'));
});
