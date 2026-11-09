/**
 * @file Tenant provisioning (operator task): company, warehouses and first administrator.
 * @module platform/tenant
 *
 * There is deliberately no public API to create companies: tenant creation is an operator
 * action (seed/CLI) so that a compromised company admin cannot create or reach other tenants.
 * The first administrator receives a one-time invitation token (72 h) to set a password and
 * enrol MFA; no default passwords exist.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database.js';
import { one } from '../../db/database.js';
import type { AuthService } from '../auth/auth.service.js';

/** Provisioning request. */
export interface ProvisionInput {
  code: string;
  name: string;
  adminEmail: string;
  adminName: string;
  warehouses: Array<{ code: string; name: string }>;
}

/** Provisioning result (token shown once to the operator). */
export interface ProvisionResult {
  companyId: string;
  adminId: string;
  invitationToken: string;
  warehouses: Record<string, string>;
}

/** Creates a tenant atomically. */
export async function provisionTenant(database: Database, auth: AuthService, input: ProvisionInput): Promise<ProvisionResult> {
  return database.systemTx(async (tx) => {
    const c = await one<{ id: string }>(tx, sql`INSERT INTO companies (code, name) VALUES (${input.code}, ${input.name}) RETURNING id`);
    const warehouses: Record<string, string> = {};
    for (const w of input.warehouses) {
      const r = await one<{ id: string }>(
        tx,
        sql`INSERT INTO warehouses (company_id, code, name) VALUES (${c.id}, ${w.code}, ${w.name}) RETURNING id`,
      );
      warehouses[w.code] = r.id;
    }
    const adminId = randomUUID();
    await tx.execute(sql`INSERT INTO users (id, company_id, email, display_name, role, status)
        VALUES (${adminId}, ${c.id}, ${input.adminEmail.toLowerCase()}, ${input.adminName}, 'ADMIN', 'INVITED')`);
    const invitationToken = await auth.issueToken(tx, adminId, c.id, 'INVITATION', null);
    return { companyId: c.id, adminId, invitationToken, warehouses };
  });
}
