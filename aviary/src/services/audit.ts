import { createAuditLogServiceWithRepository } from '@aviary-ai/audit-log';
import { MySQLAuditLogRepository } from '@aviary-ai/audit-log-mysql';
import { sequelize } from '../database';

const auditLogRepository = new MySQLAuditLogRepository(sequelize);

export const { service: auditLogService } =
    createAuditLogServiceWithRepository(auditLogRepository, {
        logWhitelist: ['/health', '/auth/captcha'],
        timeFormat: 'YYYY/MM/DD HH:mm:ss',
        maxParamLength: 2000,
    });

export const auditLogDeps = {
    service: auditLogService,
    repository: auditLogRepository,
};
