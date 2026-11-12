/**
 * @file Authentication, MFA and administration contracts.
 * @module contracts (owning module: platform identity)
 */
import { z } from 'zod';
import { Code, SafeLine, SafeText, Uuid } from './common.js';
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

/**
 * Recovery code format: 6 groups of 4 base32 characters (120 bits, v0.6.6+) or the legacy
 * 4 groups (80 bits, issued before v0.6.6 and valid until used or regenerated).
 */
export const RecoveryCode = z
  .string()
  .max(40)
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}((-[A-Z2-7]{4}){2})?$/.test(s), 'Código de recuperação inválido');

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

// ---------------------------------------------------------------- passkeys & account (v0.6)

/** base64url string (WebAuthn binary fields). */
const B64u = z.string().regex(/^[A-Za-z0-9_-]{1,16000}$/, 'base64url inválido');

/** WebAuthn registration response as produced by @simplewebauthn/browser (strict shape). */
export const WebAuthnRegistrationResponse = z
  .object({
    id: B64u,
    rawId: B64u,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: B64u,
        attestationObject: B64u,
        authenticatorData: B64u.optional(),
        transports: z
          .array(z.string().regex(/^[a-z-]{1,20}$/))
          .max(10)
          .optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: B64u.optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** WebAuthn authentication (assertion) response. */
export const WebAuthnAuthenticationResponse = z
  .object({
    id: B64u,
    rawId: B64u,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: B64u,
        authenticatorData: B64u,
        signature: B64u,
        userHandle: B64u.optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** Register a passkey (after step-up). */
export const PasskeyRegisterInput = z.object({ response: WebAuthnRegistrationResponse, name: SafeLine(60) }).strict();

/** Present a passkey assertion (login second factor or step-up). */
export const PasskeyAssertInput = z.object({ response: WebAuthnAuthenticationResponse }).strict();

/** Self-service password change. */
export const ChangePasswordInput = z.object({ currentPassword: z.string().min(1).max(128), newPassword: NewPassword }).strict();

/** Security monitoring (ADR-0026): counters window, 5 minutes … 7 days. */
export const SecurityOverviewQuery = z.object({ windowMinutes: z.coerce.number().int().min(5).max(10_080).default(60) }).strict();

/** Security alert list filter. */
export const SecurityAlertsQuery = z
  .object({
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'ALL']).default('OPEN'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/** Acknowledging an alert (one-way; requires step-up). */
export const AcknowledgeAlertInput = z.object({ note: SafeText(300).optional() }).strict();
