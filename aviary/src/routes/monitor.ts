import { createAuditLogRouter } from '@aviary-ai/audit-log';
import Router from '@koa/router';
import { auditLogService } from '../services/audit';

const monitorRouter: Router = createAuditLogRouter(auditLogService);

export default monitorRouter;
