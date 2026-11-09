/**
 * @file Authentication, MFA and administration contracts.
 * @module contracts (owning module: platform identity)
 */
import { z } from 'zod';
import { Code, SafeLine, Uuid } from './common.js';
import { PERMISSIONS, ROLES } from './permissions.js';

/** Normalised e-mail address (lower-case, NFC, max 254). */
export const Email = z
  .string()
  .max(254)
  .transform((s) => s.normalize('NFC').trim().toLowerCase())
  .refine((s) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/.test(s), 'E-mail inválido');

/**
 * Password policy aligned with NIST SP 800-63B-4: length is what matters (min 12 here, above
 * the 8/15 floors), max 128, all printable Unicode allowed, no composition rules, breached /
 * common-password screening performed server-side.
 */
export const NewPassword = z.string().min(12, 'Mínimo 12 caracteres').max(128, 'Máximo 128 caracteres');

/** Login step 1. Password is never logged (see logger redaction). */
export const LoginInput = z.object({ email: Email, password: z.string().min(1).max(128) }).strict();

/** Six-digit TOTP code. */
export const TotpCode = z.string().regex(/^\d{6}$/, 'Código de 6 dígitos');

/** Recovery code format: 4 groups of 4 base32 chars separated by '-'. */
export const RecoveryCode = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(s), 'Código de recuperação inválido');

/** MFA verification (second step of login). Exactly one factor. */
export const MfaVerifyInput = z
  .object({ code: TotpCode.optional(), recoveryCode: RecoveryCode.optional() })
  .strict()
  .refine((v) => (v.code ? 1 : 0) + (v.recoveryCode ? 1 : 0) === 1, 'Indique um único fator');

/** Step-up re-verification for high-risk actions. */
export const StepUpInput = z.object({ code: TotpCode }).strict();

/** One-time token presented by invitation / reset links (never logged). */
export const OneTimeToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Token inválido');

/** Accept invitation: set password, receive TOTP enrolment secret. */
export const AcceptInvitationInput = z.object({ token: OneTimeToken, password: NewPassword }).strict();

/** Confirm TOTP enrolment for an invitation/MFA-reset token. */
export const ConfirmEnrollmentInput = z.object({ token: OneTimeToken, code: TotpCode }).strict();

/** Password reset with an administrator-issued one-time token. */
export const ResetPasswordInput = z.object({ token: OneTimeToken, password: NewPassword }).strict();

/** Create a warehouse (admin). */
export const CreateWarehouseInput = z.object({ code: Code, name: SafeLine(80) }).strict();

/** Invite/create a user (admin). Staff must be bound to exactly one warehouse. */
export const CreateUserInput = z
  .object({
    email: Email,
    displayName: SafeLine(80),
    role: z.enum(ROLES),
    warehouseId: Uuid.optional(),
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
    phone: z
      .string()
      .regex(/^\+?[0-9 ]{6,20}$/)
      .optional(),
  })
  .strict()
  .refine((u) => u.role === 'ADMIN' || !!u.warehouseId, 'Funcionários têm de ter um armazém atribuído');

/** Update a staff member's permissions (admin). */
export const UpdatePermissionsInput = z.object({ permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length) }).strict();

/** Change a staff member's assigned warehouse (admin, step-up). */
export const UpdateWarehouseAssignmentInput = z.object({ warehouseId: Uuid }).strict();

/** Admin-only active warehouse switch (UI context; enforcement is per request). */
export const SwitchWarehouseInput = z.object({ warehouseId: Uuid }).strict();
