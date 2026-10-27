import { posix } from 'node:path';
import { parseAllDocuments, LineCounter } from 'yaml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Finding, Ecosystem, Source } from '../types.js';
import { supportedVersion } from './versions.js';

export type Data = Record<string, any>;
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Data;
}
export function json(text: string): Data { return object(JSON.parse(text)); }
class YamlDiagnostic extends Error {}
export function fileParseError(path: string, error: unknown): Error {
  const diagnostic = error instanceof YamlDiagnostic ? `: ${error.message}` : '';
  return new Error(`Cannot parse ${path}${diagnostic}; previous project findings were preserved`);
}
export function yaml(text: string, dialect: 'ci' | 'compose' = 'ci'): Data {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter, prettyErrors: false, merge: dialect === 'compose',
    customTags: [{ tag: '!reference', collection: 'seq', resolve: (value: unknown) => value }] });
  const diagnostic = (code: string, offset: number) => {
    const { line, col } = lineCounter.linePos(offset);
    return new YamlDiagnostic(`YAML ${code} at line ${line}, column ${col}`);
  };
  const values = documents.map(doc => {
    const error = doc.errors[0];
    if (error) throw diagnostic(error.code, error.pos[0]);
    let value: unknown;
    try { value = doc.toJS({ maxAliasCount: 100 }) ?? {}; }
    catch { throw diagnostic('ALIAS_RESOLUTION_FAILED', doc.range?.[0] ?? 0); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw diagnostic('EXPECTED_MAPPING', doc.range?.[0] ?? 0);
    return value as Data;
  });
  if (values.length <= 1) return values[0] ?? {};
  const header = values[0]!;
  if (dialect === 'ci' && values.length === 2 && Object.keys(header).length === 1 && Object.hasOwn(header, 'spec')) return values[1]!;
  throw diagnostic('MULTIPLE_DOCS', documents[1]?.range?.[0] ?? 0);
}
export function xml(text: string): Data {
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error('Invalid XML');
  return object(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false, parseTagValue: false }).parse(text));
}
export function list<T>(value: T | T[] | null | undefined): T[] {
  return value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
}
export class Collector {
  readonly findings: Finding[] = [];
  constructor(readonly file: string) {}
  add(technology: string, version: unknown, ecosystem: Ecosystem, source: Source = 'manifest', reason?: string, selector?: string): void {
    const raw = version === undefined || version === null || version === '' ? null : String(version).trim();
    const normalized = selector ?? raw;
    const unresolved = reason ?? (normalized && !supportedVersion(normalized, ecosystem) ? 'Unsupported or dynamic version expression' : null);
    this.findings.push({ technology: technology.toLowerCase(), version: raw, ecosystem, component: posix.dirname(this.file), source, file: this.file,
      status: unresolved ? 'unresolved' : raw === null ? 'unknown' : 'resolved', reason: unresolved, ...(selector === undefined ? {} : { selector }) });
  }
  image(image: string, source: Source): void {
    const withoutDigest = image.split('@')[0]!;
    const last = withoutDigest.split('/').at(-1)!;
    const separator = last.indexOf(':');
    const name = separator < 0 ? last : last.slice(0, separator);
    const tag = separator < 0 ? undefined : last.slice(separator + 1);
    const registryPath = withoutDigest.split(':')[0]!;
    const technology = ({ node: 'node', python: 'python', golang: 'go', php: 'php', openjdk: 'java', 'eclipse-temurin': 'java', 'amazoncorretto': 'java', 'ibm-semeru-runtimes': 'java', maven: 'maven', gradle: 'gradle' } as Record<string, string>)[name!]
      ?? (registryPath.includes('/dotnet/') && ['sdk', 'runtime', 'aspnet', 'runtime-deps'].includes(name!) ? 'dotnet' : undefined);
    if (!technology) {
      if (/\$/.test(image)) this.add('container-image', image, 'generic', source, 'Unresolved container image variable');
      return;
    }
    const selector = tag?.match(/^(\d+(?:\.\d+){0,2})(?:-(?:alpine|slim|bookworm|bullseye|buster|trixie|jammy|noble|focal|jdk|jre|nanoserver|windowsservercore|al2023|al2)(?:[\w.-]*))?$/)?.[1];
    this.add(technology, tag ?? (image.includes('@') ? image.split('@')[1] : null), 'generic', source, undefined, selector);
  }
}
const excluded = new Set(['node_modules', 'vendor', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'bin', 'obj', 'coverage', '.next', '.nuxt', '.output', '.gradle', '.yarn']);
export function excludedPath(path: string): boolean { return path.split('/').some(p => excluded.has(p)); }
export function isDockerfile(name: string): boolean { return /^Dockerfile(?:[.-].*)?$/.test(name) || /\.Dockerfile$/.test(name); }
export function isComposeFile(name: string): boolean { return /^(?:docker-compose|compose)(?:\..+)?\.ya?ml$/.test(name); }
export function relevantFile(path: string): boolean {
  if (excludedPath(path)) return false;
  const name = posix.basename(path);
  return /^(?:package\.json|\.nvmrc|\.node-version|\.python-version|\.tool-versions|\.java-version|\.sdkmanrc|\.go-version|\.php-version|runtime\.txt|pyproject\.toml|Pipfile|requirements(?:[-.][\w-]+)?\.txt|pom\.xml|build\.gradle(?:\.kts)?|gradle\.properties|global\.json|Directory\.(?:Build|Packages)\.props|go\.mod|composer\.json|\.gitlab-ci\.ya?ml)$/.test(name)
    || /\.(?:csproj|fsproj|vbproj)$/.test(name) || isDockerfile(name) || isComposeFile(name);
}
