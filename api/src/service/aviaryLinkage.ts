import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { DbMode } from '@/db/adapter';

export type AviaryLinkProfile = 'core' | 'mysql-adapter';

export type AviaryPackageLink = {
  name: string;
  version: string;
  profile: AviaryLinkProfile;
  mappedFeatures: string[];
  requiredOnPostgres: boolean;
  requiredOnMysql: boolean;
};

export type AviaryPackageStatus = AviaryPackageLink & {
  installed: boolean;
  installedVersion: string | null;
};

const link = (
  name: string,
  version: string,
  profile: AviaryLinkProfile,
  mappedFeatures: string[],
): AviaryPackageLink => ({
  name,
  version,
  profile,
  mappedFeatures,
  requiredOnPostgres: profile === 'core',
  requiredOnMysql: true,
});

export const AVIARY_PACKAGE_LINKS: AviaryPackageLink[] = [
  link('@aviary-ai/ai-gateway', '^1.0.10', 'core', ['llm-provider abstraction', '/api/aviary/v1/tasks']),
  link('@aviary-ai/async-tasks', '^1.0.10', 'core', ['task lifecycle', '/api/aviary/v1/tasks']),
  link('@aviary-ai/async-tasks-mysql', '^1.0.10', 'mysql-adapter', ['mysql async-task repositories']),
  link('@aviary-ai/audit-log', '^1.0.10', 'core', ['/api/aviary/v1/audit/events']),
  link('@aviary-ai/audit-log-mysql', '^1.0.10', 'mysql-adapter', ['mysql audit repositories']),
  link('@aviary-ai/identity-access', '^1.0.10', 'core', ['/api/aviary/v1/auth/login', '/api/aviary/v1/auth/me']),
  link('@aviary-ai/identity-access-mysql', '^1.0.10', 'mysql-adapter', ['mysql identity adapter']),
  link('@aviary-ai/governance-config', '^1.0.10', 'core', ['runtime config management']),
  link('@aviary-ai/governance-config-mysql', '^1.0.10', 'mysql-adapter', ['mysql governance repositories']),
  link('@aviary-ai/domain-meta', '^1.0.10', 'core', ['domain/organization metadata']),
  link('@aviary-ai/domain-meta-mysql', '^1.0.10', 'mysql-adapter', ['mysql domain-meta repositories']),
  link('@aviary-ai/identity-management', '^1.0.10', 'core', ['roles/users/menus management']),
  link('@aviary-ai/identity-management-mysql', '^1.0.10', 'mysql-adapter', ['mysql identity-management repositories']),
  link('@aviary-ai/infra-queue', '^1.0.10', 'core', ['queue abstraction', 'bull queue integration']),
  link('@aviary-ai/infra-storage', '^1.0.0', 'core', ['file/storage abstraction']),
];

const requireFromApi = createRequire(path.resolve(__dirname, '../../package.json'));

const resolveInstalledVersion = (pkgName: string): string | null => {
  try {
    const pkgJsonPath = requireFromApi.resolve(`${pkgName}/package.json`);
    const pkgJsonRaw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(pkgJsonRaw) as { version?: string };
    return pkgJson.version || null;
  } catch {
    return null;
  }
};

export const getAviaryPackageStatuses = (): AviaryPackageStatus[] => {
  return AVIARY_PACKAGE_LINKS.map((pkg) => {
    const installedVersion = resolveInstalledVersion(pkg.name);
    return {
      ...pkg,
      installed: Boolean(installedVersion),
      installedVersion,
    };
  });
};

export const summarizeAviaryStatuses = (rows: AviaryPackageStatus[], dbMode: DbMode = 'postgres') => {
  const total = rows.length;
  const installed = rows.filter((item) => item.installed).length;
  const missing = total - installed;
  const coreTotal = rows.filter((item) => item.profile === 'core').length;
  const coreInstalled = rows.filter((item) => item.profile === 'core' && item.installed).length;
  const mysqlTotal = rows.filter((item) => item.profile === 'mysql-adapter').length;
  const mysqlInstalled = rows.filter((item) => item.profile === 'mysql-adapter' && item.installed).length;
  const requiredRows = rows.filter((item) => (dbMode === 'postgres' ? item.requiredOnPostgres : item.requiredOnMysql));
  const requiredInstalled = requiredRows.filter((item) => item.installed).length;
  const requiredMissing = requiredRows.length - requiredInstalled;

  return {
    dbMode,
    total,
    installed,
    missing,
    required: {
      profile: dbMode === 'postgres' ? 'core' : 'core+mysql-adapter',
      total: requiredRows.length,
      installed: requiredInstalled,
      missing: requiredMissing,
      ready: requiredMissing === 0,
    },
    core: {
      total: coreTotal,
      installed: coreInstalled,
      missing: coreTotal - coreInstalled,
    },
    mysqlAdapter: {
      total: mysqlTotal,
      installed: mysqlInstalled,
      missing: mysqlTotal - mysqlInstalled,
    },
  };
};
