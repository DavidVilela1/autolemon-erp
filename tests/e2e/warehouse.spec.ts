/**
 * @file Browser end-to-end flow (real API + real Postgres + real browser):
 * invitation → password → TOTP enrolment → login with MFA → structure → SKU → receiving by
 * scanner → putaway → stock visible; plus axe accessibility checks and CSP header presence.
 * @module tests/e2e
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { totpNow } from '../../apps/api/src/platform/auth/totp.js';

const PASSWORD = 'cavalo correto bateria agrafo 2026';
const token = process.env.E2E_INVITE!;
const email = process.env.E2E_EMAIL!;
let secret = '';

/** Waits for the next TOTP step so a fresh code is never a replay. */
async function freshCode(): Promise<string> {
  const msInStep = Date.now() % 30_000;
  await new Promise((r) => setTimeout(r, 30_000 - msInStep + 500));
  return totpNow(secret);
}

test.describe.configure({ mode: 'serial' });

test('invitation enrolment, MFA login and accessible login page', async ({ page }) => {
  const res = await page.goto(`/#/convite/${token}`);
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page).toHaveURL(/#\/convite$/); // token removed from address bar
  await page.getByRole('textbox', { name: /Palavra-passe/ }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  secret = (await page.getByLabel('Chave secreta TOTP').innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByRole('textbox', { name: 'Código de 6 dígitos' }).fill(totpNow(secret));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Conta ativada')).toBeVisible();
  await page.getByRole('button', { name: 'Ir para o início de sessão' }).click();

  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await page.getByRole('textbox', { name: 'Palavra-passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel(/Código da aplicação/).fill(await freshCode());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible();
  // No tokens in web storage.
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).toBe('{}{}');

  // --- structure
  await page.getByRole('link', { name: 'Estrutura' }).click();
  const createNode = async (kind: string, code: string, parent?: string) => {
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).first().selectOption({ label: kind });
    if (parent) await page.getByLabel('Dentro de').selectOption({ label: parent });
    else await page.getByLabel('Dentro de').selectOption('');
    await page.getByRole('textbox', { name: 'Código', exact: true }).first().fill(code);
    await page.getByRole('textbox', { name: 'Nome', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Criar localização' }).click();
    await expect(page.getByText('Localização criada.')).toBeVisible();
  };
  await createNode('Zona', 'Z1');
  await createNode('Estante', 'R1', 'Z1');
  await createNode('Prateleira', 'P1', 'Z1/R1');
  await createNode('Cais de receção', 'REC');
  // Unsupported nesting is refused with a clear message.
  await page.getByRole('combobox', { name: 'Tipo', exact: true }).first().selectOption({ label: 'Zona' });
  await page.getByLabel('Dentro de').selectOption({ label: 'Z1/R1' });
  await page.getByRole('textbox', { name: 'Código', exact: true }).first().fill('BAD');
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('BAD');
  await page.getByRole('button', { name: 'Criar localização' }).click();
  await expect(page.getByRole('alert')).toContainText('Não é suportado');

  // --- SKU with hostile description rendered as text
  await page.getByRole('link', { name: 'Artigos' }).click();
  await page.getByRole('textbox', { name: 'Código', exact: true }).fill('BRK-E2E');
  await page.getByLabel('Código de barras (EAN)').fill('5600000009999');
  await page.getByRole('textbox', { name: 'Descrição', exact: true }).fill('<img src=x onerror="window.__xss=1">Pastilhas');
  await page.getByRole('button', { name: 'Criar', exact: true }).click();
  await expect(page.getByText('Artigo criado.')).toBeVisible();
  await expect(page.getByRole('cell', { name: '<img src=x onerror="window.__xss=1">Pastilhas' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // --- receiving with scanner input
  await page.getByRole('link', { name: 'Receção' }).click();
  await page
    .getByLabel('Artigo previsto (vazio = não planeada)')
    .selectOption({ label: 'BRK-E2E · <img src=x onerror="window.__xss=1">Pastilhas' });
  await page.getByRole('textbox', { name: 'Quantidade prevista' }).fill('5');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByText('Entrada criada.')).toBeVisible();
  await page.getByLabel('Cais de receção').selectOption({ label: 'REC (STAGING)' });
  await page.getByLabel('Quantidade por leitura').fill('4');
  const scan = page.getByLabel('Ler código de barras do artigo');
  await scan.fill('5600000009999');
  await scan.press('Enter');
  await expect(page.getByText('Recebido 4 × 5600000009999.')).toBeVisible();
  await page.getByRole('button', { name: 'Fechar receção' }).click();
  await expect(page.getByText(/faltas\/excessos registados/)).toBeVisible();

  // --- putaway
  await page.getByRole('link', { name: 'Arrumação' }).click();
  await page.getByRole('button', { name: 'Arrumar' }).first().click();
  await page.getByLabel('Destino').selectOption({ label: 'Z1/R1/P1 (SHELF)' });
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Arrumação registada.')).toBeVisible();

  // --- stock page shows 4 available units; accessibility of an operational screen
  await page.getByRole('link', { name: 'Stock' }).click();
  await expect(page.getByRole('row', { name: /BRK-E2E/ }).first()).toContainText('4');
  const a11y2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(a11y2.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // --- logout ends the server session
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  const r = await page.request.get('/api/auth/session');
  expect(r.status()).toBe(401);
});
