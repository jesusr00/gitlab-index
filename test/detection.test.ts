import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/detection/index.js';
import { matchesVersion } from '../src/detection/versions.js';

const scan = (path: string, content: string) => detect(new Map([[path, content]]));
test('Node declarations preserve conflicts and nested component evidence', () => {
  const findings = detect(new Map([
    ['apps/api/.nvmrc', '24\n'],
    ['apps/api/Dockerfile', 'FROM node:24-alpine AS build\nFROM node:22-slim'],
    ['apps/api/package.json', JSON.stringify({ engines: { node: '>=20' }, dependencies: { react: '^19.0.0' } })],
    ['.gitlab-ci.yml', 'image: node:22\n'],
  ]));
  const node = findings.filter(f => f.technology === 'node');
  assert.equal(node.length, 5);
  assert.equal(node.filter(f => matchesVersion(f, { major: 24 })).length, 2);
  assert.equal(node.filter(f => matchesVersion(f, { compatibleWith: '24.0.0' })).length, 3);
  assert.ok(findings.some(f => f.technology === 'react' && f.component === 'apps/api'));
});
test('supports manifests across six ecosystems', () => {
  const files = new Map([
    ['package.json', '{"packageManager":"pnpm@10.0.0","dependencies":{"next":"15.0.0"}}'],
    ['pyproject.toml', '[project]\nrequires-python = ">=3.12,<4"\ndependencies = ["Django>=5.0,<6", "flask"]\n'],
    ['pom.xml', '<project><properties><java.version>21</java.version><spring.version>3.4.0</spring.version></properties><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId><version>${spring.version}</version></dependency></dependencies></project>'],
    ['global.json', '{"sdk":{"version":"9.0.100"}}'],
    ['App.csproj', '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>'],
    ['go.mod', 'module example.com/app\ngo 1.23.0\nrequire github.com/gin-gonic/gin v1.10.0\n'],
    ['composer.json', '{"require":{"php":"^8.3","laravel/framework":"^11.0"}}'],
  ]);
  const f = detect(files);
  for (const technology of ['pnpm', 'next', 'python', 'django', 'flask', 'java', 'org.springframework.boot:spring-boot-starter', 'dotnet', 'newtonsoft.json', 'go', 'github.com/gin-gonic/gin', 'php', 'laravel/framework']) {
    assert.ok(f.some(x => x.technology === technology), technology);
  }
  assert.equal(f.find(x => x.technology === 'flask')?.status, 'unknown');
});
test('unresolved variables, external includes, and unsupported versions are explicit', () => {
  const f = detect(new Map([
    ['Dockerfile', 'FROM node:${NODE_VERSION}\n'],
    ['.gitlab-ci.yml', 'include:\n  - project: team/templates\n    file: ci.yml\nimage: node:$NODE_VERSION\n'],
    ['package.json', '{"dependencies":{"react":"workspace:*"}}'],
  ]));
  assert.equal(f.filter(x => x.status === 'unresolved').length, 4);
  assert.equal(f.find(x => x.status === 'unknown')?.technology, 'node');
  assert.ok(f.every(x => !matchesVersion(x, { major: 24 })));
});
test('malformed manifests fail instead of replacing a good snapshot with partial data', () => {
  assert.throws(() => scan('package.json', '{broken'), /package.json/);
  assert.throws(() => scan('pyproject.toml', '[project'), /pyproject.toml/);
  assert.throws(() => scan('pom.xml', '<project>'), /pom.xml/);
});
test('version queries distinguish explicit selections and ecosystem compatibility', () => {
  const f = scan('package.json', '{"engines":{"node":">=20"},"dependencies":{"react":"^19.0.0"}}');
  assert.equal(matchesVersion(f[0]!, { major: 24 }), false);
  assert.equal(matchesVersion(f[1]!, { version: '19.0.0' }), false);
  assert.equal(matchesVersion(f[1]!, { compatibleWith: '19.2.0' }), true);
  const php = scan('composer.json', '{"require":{"php":"~8.2"}}')[0]!;
  assert.equal(matchesVersion(php, { compatibleWith: '8.4.0' }), true);
  assert.equal(matchesVersion(php, { compatibleWith: '9.0.0' }), false);
  const py = scan('pyproject.toml', '[project]\nrequires-python = "~=3.12.0"')[0]!;
  assert.equal(matchesVersion(py, { compatibleWith: '3.12.8' }), true);
  assert.equal(matchesVersion(py, { compatibleWith: '3.13.0' }), false);
});
test('manifest presence identifies runtimes even when no version is specified', () => {
  const f = detect(new Map([
    ['pom.xml', '<project><modelVersion>4.0.0</modelVersion></project>'],
    ['build.gradle.kts', 'plugins { id("java") }'],
    ['App.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>'],
  ]));
  assert.equal(f.filter(x => x.technology === 'java' && x.status === 'unknown').length, 2);
  assert.equal(f.filter(x => x.technology === 'dotnet' && x.status === 'unknown').length, 1);
});
test('NuGet minimum releases, Maven intervals and Python exact constraints use their own semantics', () => {
  const f = detect(new Map([
    ['App.csproj', '<Project><ItemGroup><PackageReference Include="Example" Version="1.2.3" /><PackageReference Include="Pinned" Version="[1.2.3]" /></ItemGroup></Project>'],
    ['pom.xml', '<project><dependencies><dependency><groupId>org.test</groupId><artifactId>example</artifactId><version>[1.0,2.0)</version></dependency></dependencies></project>'],
    ['requirements.txt', 'django==5.0.0\nflask @ https://example.com/flask.whl\n'],
  ]));
  assert.equal(matchesVersion(f.find(x => x.technology === 'example')!, { compatibleWith: '1.5.0' }), true);
  assert.equal(matchesVersion(f.find(x => x.technology === 'pinned')!, { compatibleWith: '1.5.0' }), false);
  assert.equal(matchesVersion(f.find(x => x.technology === 'org.test:example')!, { compatibleWith: '1.5.0' }), true);
  assert.equal(matchesVersion(f.find(x => x.technology === 'org.test:example')!, { compatibleWith: '2.0.0' }), false);
  assert.equal(matchesVersion(f.find(x => x.technology === 'django')!, { version: '5.0.0' }), true);
  assert.equal(f.find(x => x.technology === 'flask')?.status, 'unresolved');
});
test('Go language directives are minimum versions and Composer bare releases are exact', () => {
  const go = scan('go.mod', 'module example.com/app\ngo 1.23.0\n').find(f => f.technology === 'go')!;
  assert.equal(matchesVersion(go, { compatibleWith: '1.24.0' }), true);
  assert.equal(matchesVersion(go, { compatibleWith: '1.22.0' }), false);
  const php = scan('composer.json', '{"require":{"php":"8.3"}}')[0]!;
  assert.equal(matchesVersion(php, { compatibleWith: '8.3.0' }), true);
  assert.equal(matchesVersion(php, { compatibleWith: '8.3.1' }), false);
});
test('GitLab CI spec headers and job documents are parsed without treating input defaults as runtime evidence', () => {
  const content = 'spec:\n  inputs:\n    image:\n      default: node:99\n---\ncheck:\n  image: node:24-alpine\n  script: !reference [.shared, script]\n';
  const f = scan('.gitlab-ci.yml', content);
  assert.equal(f.filter(x => x.technology === 'node').length, 1);
  assert.equal(matchesVersion(f[0]!, { major: 24 }), true);
});
test('malformed CI diagnostics report positions without exposing source content', () => {
  const content = 'spec:\n  inputs: {}\n---\njob:\n  image: [node:24\n  secret: DO_NOT_EXPOSE_THIS_VALUE\n';
  assert.throws(() => scan('.gitlab-ci.yml', content), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cannot parse .gitlab-ci.yml/);
    assert.match(error.message, /YAML .* at line \d+, column \d+/);
    assert.ok(!error.message.includes('DO_NOT_EXPOSE_THIS_VALUE'));
    return true;
  });
});
test('unrelated YAML documents are rejected rather than silently discarding job evidence', () => {
  assert.throws(() => scan('.gitlab-ci.yml', 'image: node:22\n---\nimage: node:24\n'), /Cannot parse/);
});
test('Docker Compose base and environment variants detect service runtime images in nested directories', () => {
  for (const name of ['docker-compose.yaml', 'docker-compose.yml', 'docker-compose.prod.yaml', 'docker-compose.dev.yml', 'docker-compose.test.local.yaml', 'compose.yaml', 'compose.yml', 'compose.prod.yaml', 'compose.dev.yml', 'compose.test.local.yaml']) {
    const f = scan(`apps/api/${name}`, 'services:\n  api:\n    image: node:24-alpine\n');
    assert.equal(f.length, 1, name);
    assert.equal(f[0]?.component, 'apps/api');
    assert.equal(f[0]?.source, 'docker');
    assert.equal(matchesVersion(f[0]!, { major: 24 }), true);
  }
  for (const name of ['compose.prod.json', 'compose.prod.yaml.bak', 'not-compose.prod.yaml', 'docker-compose-prod.yaml']) {
    assert.equal(scan(name, 'services:\n  api:\n    image: node:24\n').length, 0, name);
  }
  assert.equal(scan('node_modules/example/compose.prod.yaml', 'services:\n  api:\n    image: node:24\n').length, 0);
});
test('Compose anchors resolve service images and variable versions remain unresolved without expansion', () => {
  const content = 'x-runtime: &runtime\n  image: node:24-alpine\nservices:\n  api:\n    <<: *runtime\n  worker:\n    image: python:3.12-slim\n  dynamic:\n    image: "node:${NODE_VERSION:-24}"\n  app:\n    image: "${APP_IMAGE}"\n  local:\n    build: .\n';
  const f = scan('compose.prod.yaml', content);
  assert.equal(f.filter(x => x.technology === 'node' && matchesVersion(x, { major: 24 })).length, 1);
  assert.equal(f.find(x => x.technology === 'python')?.selector, '3.12');
  assert.equal(f.find(x => x.technology === 'node' && x.status === 'unresolved')?.version, '${NODE_VERSION:-24}');
  assert.equal(f.find(x => x.technology === 'container-image')?.status, 'unresolved');
  assert.equal(f.length, 4);
});
test('Compose rejects malformed and multiple-document YAML without leaking source contents', () => {
  assert.throws(() => scan('compose.prod.yaml', 'services:\n  api:\n    image: [node:24\n'), /YAML .* at line/);
  assert.throws(() => scan('compose.prod.yaml', 'spec:\n  inputs: {}\n---\nservices:\n  api:\n    image: node:24\n'), /MULTIPLE_DOCS/);
});
