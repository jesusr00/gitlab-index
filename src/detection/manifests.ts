import { posix } from 'node:path';
import { parse as toml } from 'smol-toml';
import { Collector, json, object, xml, list, type Data } from './shared.js';

function dependencies(c: Collector, deps: Data | undefined, ecosystem: 'npm' | 'composer', prefix = ''): void {
  for (const [name, value] of Object.entries(deps ?? {})) c.add(prefix + name, typeof value === 'string' ? value : null, ecosystem);
}
function pythonDependency(c: Collector, declaration: string): void {
  const m = declaration.trim().match(/^([\w.-]+)(?:\[[^\]]+\])?\s*(?:\(([^)]+)\)|([^;]*))?(?:;.*)?$/);
  if (!m) { c.add('python-dependency', declaration, 'python', 'manifest', 'Unsupported dependency declaration'); return; }
  const name = m[1]!.toLowerCase().replace(/[-_.]+/g, '-');
  const spec = (m[2] ?? m[3] ?? '').trim();
  c.add(name, spec || null, 'python');
}
function poetry(c: Collector, deps: Data): void {
  for (const [name, value] of Object.entries(deps)) {
    const version = typeof value === 'string' ? value : value?.version;
    c.add(name === 'python' ? 'python' : name.replace(/[-_.]+/g, '-'), version ?? (value ? JSON.stringify(value) : null), 'python');
  }
}
function maven(c: Collector, text: string): void {
  const p = xml(text).project;
  if (!p || typeof p !== 'object') throw new Error('Missing project element');
  const props = p.properties ?? {};
  const resolve = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    let result = String(v);
    for (let i = 0; i < 10; i++) {
      const replaced = result.replace(/\$\{([^}]+)\}/g, (match, key) => typeof props[key] === 'string' ? props[key] : match);
      if (replaced === result) break;
      result = replaced;
    }
    return result;
  };
  for (const key of ['java.version', 'maven.compiler.release', 'maven.compiler.source', 'maven.compiler.target']) {
    if (props[key] !== undefined) {
      const version = resolve(props[key]);
      c.add('java', version, 'generic', 'runtime', undefined, version?.startsWith('1.') ? version.slice(2) : undefined);
    }
  }
  for (const dep of list<Data>(p.dependencies?.dependency)) c.add(`${dep.groupId ?? '?'}:${dep.artifactId ?? '?'}`, resolve(dep.version), 'maven');
  if (p.parent?.artifactId) c.add(`${p.parent.groupId ?? '?'}:${p.parent.artifactId}`, resolve(p.parent.version), 'maven');
  if (!c.findings.some(f => f.technology === 'java')) c.add('java', null, 'generic', 'runtime');
}
function dotnet(c: Collector, text: string): void {
  const p = xml(text).Project;
  if (!p || typeof p !== 'object') throw new Error('Missing Project element');
  const props = Object.assign({}, ...list<Data>(p.PropertyGroup));
  const resolve = (s: unknown) => typeof s === 'string' ? s.replace(/\$\(([^)]+)\)/g, (m, key) => typeof props[key] === 'string' ? props[key] : m) : s;
  for (const group of list<Data>(p.PropertyGroup)) {
    for (const tfm of String(group.TargetFrameworks ?? group.TargetFramework ?? '').split(';').filter(Boolean)) {
      const m = tfm.match(/^net(?:coreapp)?(\d+\.\d+)(?:-[\w.]+)?$/);
      c.add('dotnet', tfm, 'generic', 'runtime', m ? undefined : 'Unsupported target framework', m?.[1]);
    }
  }
  if (!c.findings.some(f => f.technology === 'dotnet')) c.add('dotnet', null, 'generic', 'runtime');
  for (const group of list<Data>(p.ItemGroup)) {
    for (const dep of [...list<Data>(group.PackageReference), ...list<Data>(group.PackageVersion)]) {
      c.add(dep.Include ?? dep.Update ?? 'dotnet-package', resolve(dep.Version ?? dep.VersionOverride), 'nuget');
    }
    for (const framework of list<Data>(group.FrameworkReference)) c.add(framework.Include ?? 'dotnet-framework', framework.Version, 'nuget');
  }
}
function gradle(c: Collector, text: string): void {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of clean.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor)\s*(?:\(\s*)?["']([^:"']+):([^:"']+)(?::([^"']+))?["']/g)) c.add(`${m[1]}:${m[2]}`, m[3], 'maven');
  for (const m of clean.matchAll(/(?:sourceCompatibility|targetCompatibility|jvmTarget)\s*(?:=\s*)?["']?((?:\d+\.)*\d+)["']?/g)) c.add('java', m[1], 'generic', 'runtime', undefined, m[1]!.startsWith('1.') ? m[1]!.slice(2) : undefined);
  for (const m of clean.matchAll(/(?:JavaLanguageVersion\.of\(\s*(\d+)\s*\)|JavaVersion\.VERSION_([\d_]+))/g)) {
    const v = (m[1] ?? m[2])!.replace(/_/g, '.');
    c.add('java', v, 'generic', 'runtime', undefined, v.startsWith('1.') ? v.slice(2) : undefined);
  }
  for (const m of clean.matchAll(/(?:id\s*(?:\(\s*)?["']([^"']+)["']\s*\)?\s*version\s*(?:\(\s*)?["']([^"']+)["'])/g)) c.add(m[1]!, m[2], 'maven');
  if (!c.findings.some(f => f.technology === 'java')) c.add('java', null, 'generic', 'runtime');
  if (/alias\s*\(|libs\.|\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\b[^\n]*\b(?:project|platform)\s*\(/.test(clean)) c.add('gradle-dependency', null, 'maven', 'manifest', 'Version catalogs or computed dependencies require Gradle evaluation');
}
export function manifests(c: Collector, text: string): void {
  const name = posix.basename(c.file);
  if (name === 'package.json') {
    const p = json(text);
    for (const [tech, v] of Object.entries(p.engines ?? {})) c.add(tech, v, 'npm', 'runtime');
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) dependencies(c, p[group], 'npm');
    if (p.packageManager) { const m = String(p.packageManager).match(/^([^@]+)@([^+]+)(?:\+.*)?$/); if (m) c.add(m[1]!, m[2], 'go'); }
    for (const [tech, v] of Object.entries(p.volta ?? {})) if (typeof v === 'string') c.add(tech, v, 'npm', 'runtime');
    if (p.devEngines) for (const kind of ['runtime', 'packageManager']) for (const e of list<Data>(p.devEngines[kind])) if (e.name) c.add(e.name, e.version, 'npm', 'runtime');
    if (!p.engines?.node && !p.volta?.node) c.add('node', null, 'npm', 'runtime');
  } else if (name === 'pyproject.toml') {
    const p = object(toml(text));
    c.add('python', p.project?.['requires-python'] ?? p.tool?.poetry?.dependencies?.python, 'python', 'runtime');
    for (const dep of p.project?.dependencies ?? []) pythonDependency(c, String(dep));
    for (const deps of Object.values(p.project?.['optional-dependencies'] ?? {})) for (const dep of deps as string[]) pythonDependency(c, dep);
    for (const deps of Object.values(p['dependency-groups'] ?? {})) for (const dep of deps as unknown[]) if (typeof dep === 'string') pythonDependency(c, dep);
    poetry(c, p.tool?.poetry?.dependencies ?? {});
    for (const group of Object.values(p.tool?.poetry?.group ?? {})) poetry(c, (group as Data).dependencies ?? {});
  } else if (name === 'Pipfile') {
    const p = object(toml(text));
    c.add('python', p.requires?.python_full_version ?? p.requires?.python_version, 'python', 'runtime');
    poetry(c, { ...p.packages, ...p['dev-packages'] });
  } else if (/^requirements.*\.txt$/.test(name)) {
    c.add('python', null, 'python', 'runtime');
    for (const line of text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
      if (line.startsWith('-')) c.add('python-requirements', line, 'python', 'manifest', 'Requirements include or installer option is not evaluated');
      else pythonDependency(c, line.replace(/\s+#.*$/, ''));
    }
  } else if (name === 'pom.xml') maven(c, text);
  else if (/^build\.gradle/.test(name)) gradle(c, text);
  else if (name === 'gradle.properties') {
    for (const m of text.matchAll(/^(?:javaVersion|java\.version|org\.gradle\.java\.installations\.auto-download)\s*=\s*(.+)$/gm)) if (!/^(true|false)$/.test(m[1]!)) c.add('java', m[1], 'generic', 'runtime');
  } else if (name === 'global.json') c.add('dotnet', json(text).sdk?.version, 'generic', 'runtime');
  else if (/\.(?:csproj|fsproj|vbproj|props)$/.test(name)) dotnet(c, text);
  else if (name === 'go.mod') {
    c.add('go', text.match(/^go\s+([\w.]+)\s*$/m)?.[1], 'go', 'runtime');
    const toolchain = text.match(/^toolchain\s+go([\w.]+)\s*$/m)?.[1];
    if (toolchain) c.add('go', toolchain, 'go', 'runtime');
    let block = false;
    for (const line of text.split('\n')) {
      if (/^require\s*\(/.test(line)) { block = true; continue; }
      if (/^\s*\)/.test(line)) { block = false; continue; }
      if (/\/\/\s*indirect\b/.test(line)) continue;
      const m = line.match(block ? /^\s*(\S+)\s+(v\S+)/ : /^require\s+(\S+)\s+(v\S+)/);
      if (m) c.add(m[1]!, m[2], 'go');
    }
  } else if (name === 'composer.json') {
    const p = json(text);
    dependencies(c, p.require, 'composer'); dependencies(c, p['require-dev'], 'composer');
    if (!p.require?.php && !p['require-dev']?.php) c.add('php', null, 'composer', 'runtime');
  }
}
